"""Minimal fixed JOG sessions sharing diagnostic transport ownership and stop queue.

No enable, release, home, clear-fault, position targets or automatic reconnect.
Feedback confirmation describes the driver, never a mechanically safe stop.
"""
import threading
import time
import uuid

from .modbus import crc16
from .motion import MotionSession
from .motion_protocol import motor_status
from .motor_protocol import jog_setup, jog_trigger, jog_ack, motor_speed
from ..storage.hardware import validate_motor_operation

CONFIRM_MS = 3000


class StartCancelled(ValueError):
    pass


def write_jog(port, bus, request, cancelled, dispatch):
    """A single restricted write; a stop interrupts waiting, not an OS write."""
    jog_ack(request, request)
    if cancelled.wait(bus.quiet):
        raise StartCancelled('启动准备已被停止取消')
    port.reset_input_buffer()
    dispatch()
    if port.write(request) != len(request):
        raise ValueError('JOG 写入不完整，结果未知，不自动重发')
    deadline = time.monotonic() + min(bus.timeout, 0.5)
    buffer = bytearray()
    while time.monotonic() < deadline:
        if cancelled.is_set():
            raise StartCancelled('启动应答等待被停止取消，执行结果需看反馈')
        buffer.extend(port.read(256))
        while len(buffer) >= 5:
            if buffer[0] != request[0] or buffer[1] not in (6, 0x86):
                del buffer[0]
                continue
            length = 5 if buffer[1] == 0x86 else 8
            if len(buffer) < length:
                break
            response = bytes(buffer[:length])
            if crc16(response[:-2]) != int.from_bytes(response[-2:], 'little'):
                del buffer[0]
                continue
            return jog_ack(request, response)
    raise ValueError('JOG 应答超时，结果未知，不自动重发')


class MotorControlSession(MotionSession):
    def __init__(self, config, factory):
        super().__init__('motors', config, factory)
        self.status.pop('motionAllowed')
        self.status.update(purpose='control', confirmationMs=CONFIRM_MS,
                           axes={target: dict(state='idle', commandId=None, error=None,
                                 driverStopped=False, physicalStopConfirmed=False) for target in self.targets})
        self.jobs = {}
        self.start_generation = 0
        self.start_cancelled = threading.Event()
        self.speed_received = {}
        self.run_deadlines = {}
        self.start_dispatched = {}
        self.stop_dispatched = {}

    def cancel_starts_locked(self):
        self.start_generation += 1
        self.start_cancelled.set()
        for key, job in self.jobs.items():
            if not job['dispatched']:
                self.status['axes'][key].update(state='idle', error='启动准备已取消')
        self.jobs.clear()

    def ready_error_locked(self, target):
        if target not in self.targets:
            return '仅支持两个固定电机'
        errors = validate_motor_operation(self.config['operation'][target], complete=True)
        if errors:
            return '；'.join(errors)
        if self.status['state'] != 'monitoring' or self.closing:
            return '电机控制会话不处于活动状态'
        if self.status['faultLatched'] or self.pending:
            return '会话故障/急停已锁存或停止尚未处理，请检查并重新连接'
        if self.status['axes'][target]['state'] != 'idle' or target in self.jobs:
            return '该电机不是待机状态，不重复启动或运行中改速'
        reading = self.status['readings'].get(target)
        now = time.monotonic()
        threshold = self.status['staleAfterMs'] / 1000
        if (not reading or now - self.last_received.get(target, 0) > threshold
                or now - self.speed_received.get(target, 0) > threshold):
            return '启动前需要新鲜有效的状态字和速度反馈'
        if reading.get('fault') or reading.get('positiveLimit') or reading.get('negativeLimit'):
            return '电机存在故障或软限位'
        if not reading.get('enabled'):
            return '驱动未使能，请现场检查；程序不自动使能'
        if reading.get('running') or reading.get('speed', {}).get('rpm') != 0:
            return '电机反馈不是静止待机，不接管外部运动'
        return None

    def decorate_snapshot_locked(self, value):
        now = time.monotonic()
        for target, reading in value['readings'].items():
            if 'speed' in reading:
                age = max(0, (now - self.speed_received[target]) * 1000)
                reading['speed'].update(ageMs=age, quality='valid' if
                    age <= value['staleAfterMs'] and value['state'] == 'monitoring' else 'stale')
        for target, axis in value['axes'].items():
            axis['startBlocked'] = self.ready_error_locked(target)
            axis['canStart'] = axis['startBlocked'] is None

    def start(self, target, session_id, config_version):
        with self.lock:
            if session_id != self.status['sessionId'] or config_version != self.status['configVersion']:
                raise ValueError('电机控制会话或配置版本已变化，请刷新后重新操作')
            error = self.ready_error_locked(target)
            if error:
                raise ValueError(error)
            command = dict(id=uuid.uuid4().hex, generation=self.start_generation, dispatched=False)
            self.jobs[target] = command
            self.status['axes'][target].update(state='starting', commandId=command['id'], error=None, driverStopped=False)
            self.note_locked(f"{target} JOG 启动入队 id={command['id']} 参数版本={config_version}")

    def stop(self, emergency=False, close=False, target=None):
        if target is not None and target not in self.targets:
            raise ValueError('无效的停止目标')
        with self.lock:
            self.cancel_starts_locked()
            for key in self.targets if target is None else (target,):
                self.run_deadlines.pop(key, None)
                self.start_dispatched.pop(key, None)
                if self.status['state'] not in ('failed', 'disconnected'):
                    axis = self.status['axes'][key]
                    if axis['state'] != 'unknown':
                        axis.update(state='stopping', driverStopped=False)
            self.stop_locked(emergency=emergency, close=close, target=target)

    def dispatch(self, target, job, trigger=False):
        with self.lock:
            if (job['generation'] != self.start_generation or self.jobs.get(target) is not job
                    or self.closing or self.pending or self.status['faultLatched'] or self.start_cancelled.is_set()):
                raise StartCancelled('启动请求已被停止、锁定或故障作废')
            if trigger:
                now = time.monotonic()
                job['dispatched'] = True
                self.run_deadlines[target] = now + self.config['operation'][target]['maxRunMs'] / 1000
                self.start_dispatched[target] = now
                self.note_locked(f"{target} JOG 触发开始发送 id={job['id']}；运动尚未确认")

    def work_pending(self, port, bus):
        with self.lock:
            if not self.jobs or self.pending or self.closing:
                return False
            target, job = next(iter(self.jobs.items()))
            self.start_cancelled.clear()
        try:
            requests = jog_setup(int(self.config[target]), self.config['operation'][target])
            for request in requests:
                write_jog(port, bus, request, self.start_cancelled, lambda: self.dispatch(target, job))
            # Refresh the target state after setup before authorizing a trigger.
            self.poll_target(bus, target)
            with self.lock:
                reading = self.status['readings'].get(target, {})
                if not reading.get('enabled') or reading.get('running') or reading.get('speed', {}).get('rpm') != 0:
                    raise ValueError('启动前复查未使能或电机不再静止')
            write_jog(port, bus, jog_trigger(int(self.config[target])), self.start_cancelled,
                      lambda: self.dispatch(target, job, trigger=True))
            with self.lock:
                self.note_locked(f"{target} JOG 收到触发回显 id={job['id']}，等待状态/速度反馈")
        except StartCancelled as exc:
            with self.lock:
                self.note_locked(f"{target} JOG 请求取消 id={job['id']}：{exc}")
        except Exception as exc:
            if not self.start_cancelled.is_set():
                with self.lock:
                    self.status['axes'][target].update(state='unknown', error=str(exc))
                self.trip(f'{target} 启动准备/触发失败：{exc}')
        finally:
            with self.lock:
                if self.jobs.get(target) is job:
                    del self.jobs[target]
        return True

    def update_reading(self, target, reading):
        with self.lock:
            speed = self.status['readings'].get(target, {}).get('speed')
            self.last_received[target] = time.monotonic()
            self.status['readings'][target] = dict(reading, receivedAt=time.time(), quality='valid')
            if speed is not None:
                self.status['readings'][target]['speed'] = speed
            state = self.status['axes'][target]['state']
            unsafe = (reading.get('fault') or reading.get('positiveLimit') or reading.get('negativeLimit')
                      or (reading.get('running') and state not in ('starting', 'running', 'stopping'))
                      or (not reading.get('enabled') and state in ('starting', 'running')))
        if unsafe:
            self.trip(f'{target} 故障/限位、未授权运行或运行中失去使能')

    def update_speed(self, target, word):
        rpm = motor_speed(word)
        reason = None
        with self.lock:
            now = time.monotonic()
            self.speed_received[target] = now
            reading = self.status['readings'][target]
            reading['speed'] = dict(rpm=rpm, raw=word, receivedAt=time.time(), quality='valid')
            axis = self.status['axes'][target]
            operation = self.config['operation'][target]
            if axis['state'] in ('starting', 'running'):
                if abs(rpm) > operation['maxSpeedRpm'] or rpm * operation['direction'] < 0:
                    reason = f'{target} 反馈速度超限或方向与配置不符'
                elif target in self.start_dispatched and reading.get('running') and rpm != 0:
                    if axis['state'] == 'starting':
                        axis['state'] = 'running'
                        self.note_locked(f'{target} 驱动反馈运行，非机械运动安全证明')
                elif axis['state'] == 'running':
                    reason = f'{target} 运行中反馈意外停止'
            elif axis['state'] == 'idle' and rpm != 0:
                reason = f'{target} 待机时存在未授权速度反馈'
            if target in self.stop_dispatched:
                sent = self.stop_dispatched[target]
                if (self.last_received[target] > sent and now > sent and not reading.get('running') and rpm == 0):
                    axis['driverStopped'] = True
                    if axis['state'] == 'stopping':
                        axis['state'] = 'idle'
                    self.stop_dispatched.pop(target, None)
                    self.note_locked(f'{target} 驱动反馈运行位为零且速度为零；机械安全停止未确认')
        if reason:
            self.trip(reason)

    def poll_target(self, bus, target):
        word = bus.read(int(self.config[target]), 4, 1)[0]
        if self.wake.is_set():
            return
        self.update_reading(target, dict(raw=word, **motor_status(word)))
        if not self.wake.is_set():
            speed = bus.read(int(self.config[target]), 10, 1)[0]
            if not self.wake.is_set():
                self.update_speed(target, speed)

    def send_stop(self, port, bus, target, command):
        with self.lock:
            self.stop_dispatched.setdefault(target, time.monotonic())
        super().send_stop(port, bus, target, command)
        unknown = False
        with self.lock:
            completed = self.status['commands'][target]
            if completed['id'] == command['id'] and completed['state'] == 'unknown':
                self.status['axes'][target].update(state='unknown', error=completed['error'])
                unknown = True
        if unknown:
            self.contain_stop_failures({target})

    def contain_stop_failures(self, failed):
        with self.lock:
            if self.closing:
                return
            self.cancel_starts_locked()
            self.run_deadlines.clear()
            self.start_dispatched.clear()
            self.closing = True
            self.status.update(state='disconnecting', faultLatched=True)
            reason = self.status['error'] or '停止反馈未知，请现场确认'
            self.status['diagnosticGuard'].update(state='tripped', reason=reason, trippedAt=time.time())
            self.note_locked('停止结果未知：取消启动、停止其余目标并关闭；不重发未知目标停止')
            for target in self.targets:
                if target not in failed:
                    self.status['axes'][target].update(state='stopping', driverStopped=False)
                    self.stop_locked(emergency=True, close=True, target=target)
            self.wake.set()

    def guard_check(self):
        super().guard_check()
        reason, expired, unconfirmed = None, [], set()
        with self.lock:
            if self.status['state'] != 'monitoring':
                return
            now = time.monotonic()
            for target, received in self.speed_received.items():
                if (now - received) * 1000 > self.status['staleAfterMs']:
                    reason = f'{target} 速度反馈过期'
                    break
            for target, axis in self.status['axes'].items():
                if target in self.run_deadlines and now >= self.run_deadlines[target]:
                    expired.append(target)
                    self.note_locked(f'{target} 已达单次运行时限，请求停止')
                elif (axis['state'] == 'starting' and target in self.start_dispatched
                        and (now - self.start_dispatched[target]) * 1000 >= CONFIRM_MS):
                    reason = f'{target} 启动反馈未在 {CONFIRM_MS} ms 内确认'
                if target in self.stop_dispatched and (now - self.stop_dispatched[target]) * 1000 >= CONFIRM_MS:
                    self.stop_dispatched.pop(target, None)
                    axis.update(state='unknown', error='停止反馈超时，不重发停止；请现场确认')
                    self.status.update(faultLatched=True, error=axis['error'])
                    self.note_locked(f'{target} 停止反馈超时，锁存且不自动重发')
                    unconfirmed.add(target)
        if unconfirmed:
            self.contain_stop_failures(unconfirmed)
            return
        if reason:
            self.trip(reason)
        else:
            for target in expired:
                self.stop(target=target)

    def finish_locked(self):
        self.start_cancelled.set()
        self.jobs.clear()
        self.run_deadlines.clear()
        self.start_dispatched.clear()
        self.stop_dispatched.clear()
        for axis in self.status['axes'].values():
            if axis['state'] in ('starting', 'running', 'stopping'):
                axis.update(state='unknown', error=axis['error'] or '会话已结束；机械停止未确认')

    def failure_stops(self, port, bus):
        # The transport may still accept writes after a failed read. Try each
        # queued target once, without reopening or retrying an uncertain write.
        for _ in self.targets:
            stop = self.take_stop()
            if stop is None:
                break
            self.send_stop(port, bus, *stop)
