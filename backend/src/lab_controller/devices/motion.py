"""Single-owner motion diagnostics. Only stop writes are permitted.

No start, enable, release, home, clear-fault or arbitrary register RPC exists.
Software stop is best effort, not a replacement for a physical safety circuit.
"""
import copy
import hashlib
import json
import threading
import time
import uuid
from collections import deque

from .modbus import ReadOnlyBus, crc16, open_serial
from .motion_protocol import (LiftFeedbackParser, lift_stop_request, motor_position, motor_status,
                              motor_stop_ack, motor_stop_request)
from .sensors import port_key

SECTIONS = ('motors', 'lift')


def write_motor_stop(port, request, timeout, interrupted):
    """One write, bounded ACK wait, no retry even after a partial write."""
    # Validate the restricted request before any I/O, not only after writing.
    motor_stop_ack(request, request)
    port.reset_input_buffer()
    if port.write(request) != len(request):
        raise ValueError('停止写入不完整，执行结果未知')
    deadline = time.monotonic() + min(timeout, 0.5)
    buffer = bytearray()
    while time.monotonic() < deadline and not interrupted.is_set():
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
            return motor_stop_ack(request, response)
    raise ValueError('停止应答超时或被更高优先级请求中断，执行结果未知；不会自动重发')


class MotionSession:
    def __init__(self, section, config, factory):
        self.section = section
        self.config = copy.deepcopy(config)
        self.factory = factory
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.preempt = threading.Event()
        self.pending = {}
        self.closing = False
        self.audit = deque(maxlen=128)
        self.audit_overflow = False
        self.last_received = {}
        self.position_received = {}
        self.targets = ('motor1', 'motor2') if section == 'motors' else ('lift',)
        self.status = dict(sessionId=uuid.uuid4().hex, section=section, source='hardware',
                           state='connecting', readings={}, commands={}, faultLatched=False,
                           error=None, startedAt=time.time(), finishedAt=None,
                           configVersion=hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
                           staleAfterMs=max(1000, config['serial']['intervalMs'] * 3),
                           motionAllowed=False, auditDropped=0)
        self.thread = threading.Thread(target=self.run, name=f'motion-{section}', daemon=True)

    def note_locked(self, message):
        if len(self.audit) == self.audit.maxlen:
            self.audit_overflow = True
            self.status['auditDropped'] += 1
            return
        self.audit.append(dict(time=time.time(), message=message))

    def snapshot(self):
        with self.lock:
            value = copy.deepcopy(self.status)
            for target, reading in value['readings'].items():
                age = (time.monotonic() - self.last_received[target]) * 1000
                reading['ageMs'] = max(0, age)
                reading['quality'] = ('valid' if age <= value['staleAfterMs']
                                      and value['state'] == 'monitoring' else 'stale')
                if 'position' in reading:
                    position_age = max(0, (time.monotonic() - self.position_received[target]) * 1000)
                    reading['position']['ageMs'] = position_age
                    reading['position']['quality'] = ('valid' if position_age <= value['staleAfterMs']
                        and value['state'] == 'monitoring' else 'stale')
            return value

    def collect(self):
        with self.lock:
            events = list(self.audit)
            self.audit.clear()
            return events

    def stop(self, emergency=False, close=False):
        with self.lock:
            if self.status['state'] in ('failed', 'disconnected'):
                return
            self.closing |= close
            if close:
                self.status['state'] = 'disconnecting'
            if emergency:
                self.status['faultLatched'] = True
                self.preempt.set()
            for target in self.targets:
                existing = self.pending.get(target)
                # Coalesce bounded stop requests; ordinary stop cannot downgrade emergency.
                if existing is None or (emergency and not existing['emergency']):
                    command = dict(id=uuid.uuid4().hex, emergency=emergency,
                                   state='queued', requestedAt=time.time(), error=None,
                                   motionConfirmed=False)
                    self.pending[target] = command
                    self.status['commands'][target] = copy.deepcopy(command)
                    self.note_locked(f"{target} 停止入队 id={command['id']} emergency={emergency}")
            self.wake.set()

    def take_stop(self):
        with self.lock:
            if not self.pending:
                self.wake.clear()
                return None
            target = max(self.pending, key=lambda key: self.pending[key]['emergency'])
            command = self.pending.pop(target)
            self.preempt.clear()
            if not self.pending:
                self.wake.clear()
            return target, command

    def send_stop(self, port, bus, target, command):
        result, error = 'unknown', None
        try:
            # RTU turnaround remains necessary even when a read was preempted.
            if self.section == 'motors':
                time.sleep(bus.quiet)
                request = motor_stop_request(int(self.config[target]), emergency=command['emergency'])
                # A newly requested emergency can interrupt an ordinary ACK wait.
                write_motor_stop(port, request, bus.timeout, self.preempt)
                result = 'acknowledged'
            else:
                request = lift_stop_request()
                if port.write(request) != len(request):
                    raise ValueError('升降停止写入不完整，执行结果未知')
                result = 'sent'
        except Exception as exc:
            error = str(exc)
        with self.lock:
            completed = dict(command, state=result, error=error, finishedAt=time.time())
            if self.status['commands'][target]['id'] == command['id']:
                self.status['commands'][target] = completed
            self.note_locked(f"{target} 停止结果 {result} id={command['id']}；未确认机械停止" + (f'：{error}' if error else ''))
            if error:
                self.status.update(faultLatched=True, error=error)

    def update_reading(self, target, reading):
        with self.lock:
            position = self.status['readings'].get(target, {}).get('position')
            self.last_received[target] = time.monotonic()
            self.status['readings'][target] = dict(reading, receivedAt=time.time(), quality='valid')
            if position is not None:
                self.status['readings'][target]['position'] = position
            fault = reading.get('fault', False) or reading.get('kind') == 'error'
            first_fault = fault and not self.status['faultLatched']
            if fault:
                self.status['faultLatched'] = True
                self.note_locked(f'{target} 故障反馈：{reading}')
        if first_fault:
            self.stop(emergency=True)

    def update_position(self, target, words):
        position = motor_position(words)
        with self.lock:
            self.position_received[target] = time.monotonic()
            self.status['readings'][target]['position'] = dict(position, receivedAt=time.time(), quality='valid')

    def run(self):
        port, error = None, None
        try:
            with self.lock:
                # A disconnect queued before opening must never open the device later.
                if self.closing:
                    return
            port = self.factory(self.config['serial'])
            bus = ReadOnlyBus(port, self.config['serial'], self.wake)
            parser = LiftFeedbackParser()
            with self.lock:
                if not self.closing:
                    self.status['state'] = 'monitoring'
                self.note_locked('串口已打开；连接不发送运动或辅助控制')
            next_poll = 0
            while True:
                stop = self.take_stop()
                if stop:
                    self.send_stop(port, bus, *stop)
                    continue
                with self.lock:
                    # A stop may arrive after take_stop() released the lock.
                    if self.pending:
                        continue
                    if self.audit_overflow:
                        raise ValueError('运动审计缓冲溢出，结束会话；请现场确认安全')
                    if self.closing:
                        break
                if self.section == 'lift':
                    for event in parser.feed(port.read(256)):
                        self.update_reading('lift', event)
                elif time.monotonic() >= next_poll:
                    for target in self.targets:
                        try:
                            word = bus.read(int(self.config[target]), 4, 1)[0]
                        except ValueError:
                            if self.wake.is_set():
                                break
                            raise
                        if self.wake.is_set():
                            break
                        self.update_reading(target, dict(raw=word, **motor_status(word)))
                        # Separate transactions are not a simultaneous status/position snapshot.
                        if self.wake.is_set():
                            break
                        try:
                            words = bus.read(int(self.config[target]), 8, 2)
                        except ValueError:
                            if self.wake.is_set():
                                break
                            raise
                        if self.wake.is_set():
                            break
                        self.update_position(target, words)
                    next_poll = time.monotonic() + self.config['serial']['intervalMs'] / 1000
                else:
                    self.wake.wait(min(0.05, max(0, next_poll - time.monotonic())))
        except Exception as exc:
            error = str(exc)
            with self.lock:
                self.status.update(state='disconnecting', error=error, faultLatched=True)
        finally:
            if port is not None:
                try:
                    port.close()
                except Exception as exc:
                    error = f'关闭串口失败：{exc}'
            with self.lock:
                for target, command in self.pending.items():
                    self.status['commands'][target] = dict(command, state='unknown',
                        error='会话已结束，未发送；设备是否停止未知', finishedAt=time.time())
                self.pending.clear()
                self.status.update(state='failed' if error else 'disconnected',
                                   error=error or self.status['error'], finishedAt=time.time())
                if error:
                    self.status['faultLatched'] = True
                self.note_locked('会话结束；关闭串口不代表设备停止' + (f'：{error}' if error else ''))


class MotionManager:
    def __init__(self, factory=open_serial):
        self.factory = factory
        self.sessions = {}
        self.closed = False

    def active(self):
        return any(session.thread.is_alive() for session in self.sessions.values())

    def connect(self, section, config):
        if self.closed or section not in SECTIONS:
            raise ValueError('不支持的运动设备连接')
        if section == 'lift' and (config['interface'] != 'RS232'
                or any(config['serial'][key] != value for key, value in
                       dict(baud=38400, bits=8, parity='N', stop=1).items())):
            raise ValueError('当前升降仅支持已知 RS232 38400/8N1，不猜测 RS485 协议')
        if section == 'motors' and (any(type(config[key]) not in (int, float)
                or not 1 <= config[key] <= 247 or int(config[key]) != config[key]
                for key in ('motor1', 'motor2')) or config['motor1'] == config['motor2']):
            raise ValueError('两个电机必须使用不同的 1～247 站号')
        if section == 'motors' and config['serial']['baud'] not in (9600, 19200, 38400, 115200):
            raise ValueError('电机波特率必须为协议支持的 9600/19200/38400/115200')
        for key, session in self.sessions.items():
            if session.thread.is_alive() and (key == section or
                    port_key(session.config['serial']['port']) == port_key(config['serial']['port'])):
                raise ValueError('设备会话或端口已被占用，请先断开')
        session = MotionSession(section, config, self.factory)
        self.sessions[section] = session
        try:
            session.thread.start()
        except Exception:
            self.sessions.pop(section, None)
            raise
        return session

    def snapshot(self):
        return {key: session.snapshot() for key, session in self.sessions.items()}

    def stop(self, section=None, emergency=False, close=False):
        for key, session in self.sessions.items():
            if section is None or key == section:
                session.stop(emergency=emergency, close=close)

    def close(self):
        self.closed = True
        self.stop(emergency=True, close=True)
        deadline = time.monotonic() + 2
        for session in self.sessions.values():
            session.thread.join(timeout=max(0, deadline - time.monotonic()))
