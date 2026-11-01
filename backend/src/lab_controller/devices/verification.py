"""Bounded, asynchronous one-shot probes; successful probes do not connect devices."""
import copy
import logging
import math
import struct
import threading
import time
import uuid
from .modbus import ReadOnlyBus, open_serial

SUPPORTED = ('motors', 'tension', 'displacement')


def probe(bus, section, config):
    if section == 'motors':
        return {name: {'station': int(config[name]), 'statusWord': bus.read(int(config[name]), 4, 1)[0]}
                for name in ('motor1', 'motor2')}
    if section == 'tension':
        low, high = bus.read(int(config['station']), 0, 2)
        raw = (high << 16) | low
        if raw & 0x80000000:
            raw -= 0x100000000
        return {'raw': raw, 'value': raw / 10 ** config['decimals'], 'unit': config['unit']}
    floating = config['reading'] == 'float'
    address = (2 if floating else 0) if config['model'] == 'p' else (
        6 + (config['channel'] - 1) * 2 if floating else config['channel'] - 1)
    registers = bus.read(int(config['station']), address, 2 if floating else 1)
    raw = struct.unpack('>f', struct.pack('>HH', *registers))[0] if floating else registers[0]
    if not math.isfinite(raw):
        raise ValueError('位移响应不是有效数值')
    value = raw
    if not floating:
        if not config['rawMin'] <= raw <= config['rawMax']:
            raise ValueError('位移原始值超出配置范围')
        value = config['lower'] + (raw - config['rawMin']) / (config['rawMax'] - config['rawMin']) * (config['upper'] - config['lower'])
    return {'raw': raw, 'value': value, 'unit': config['unit']}


class VerificationManager:
    def __init__(self, factory=open_serial):
        self.factory = factory
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.thread = None
        self.closed = False
        self.result = {'state': 'idle', 'sessionId': None, 'section': None,
                       'message': '尚未验证；当前试验仍使用模拟设备', 'readings': None, 'phase': 'closed'}

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.result)

    def active(self):
        return self.thread is not None and self.thread.is_alive()

    def start(self, section, config):
        if self.closed:
            raise ValueError('连接管理器已关闭')
        if self.active():
            raise ValueError('已有验证任务正在执行，请等待完成或取消')
        if section not in SUPPORTED:
            raise ValueError('该设备暂不支持只读验证：升降反馈协议及电子皮肤 SDK 尚待确认')
        self.cancelled = threading.Event()
        session = uuid.uuid4().hex
        with self.lock:
            self.result = {'state': 'checking', 'sessionId': session, 'section': section,
                           'message': '正在进行一次性只读验证；不会切换为真实试验', 'readings': None,
                           'port': config['serial']['port'], 'startedAt': time.time(), 'phase': 'opening'}
        self.thread = threading.Thread(target=self.run, args=(session, section, copy.deepcopy(config)),
                                       daemon=True, name='hardware-verification')
        self.thread.start()
        return self.snapshot()

    def run(self, session, section, config):
        port = None
        state, message, readings = 'failed', '验证失败', None
        stage = '打开端口失败'
        try:
            if self.cancelled.is_set():
                raise ValueError('验证已取消')
            port = self.factory(config['serial'])
            stage = '读取响应失败'
            with self.lock:
                self.result.update(phase='reading', message='端口已打开，正在等待有效只读响应')
            readings = probe(ReadOnlyBus(port, config['serial'], self.cancelled), section, config)
            state, message = 'passed', '只读通信验证通过；端口已释放，不代表型号确认或设备允许运动'
        except Exception as exc:
            message = f'{stage}：{exc}'
            logging.info('硬件只读验证失败 (%s): %s', section, exc)
        finally:
            if port is not None:
                try:
                    port.close()
                except Exception:
                    state, message, readings = 'failed', '关闭串口失败，请检查设备连接', None
                    logging.exception('关闭验证串口失败')
            if self.cancelled.is_set():
                state, message, readings = 'cancelled', '验证已取消，结果不再有效', None
            with self.lock:
                if self.result['sessionId'] == session:
                    self.result.update(state=state, message=message, readings=readings, finishedAt=time.time(), phase='closed')

    def cancel(self):
        self.cancelled.set()
        return self.snapshot()

    def invalidate(self):
        if self.active():
            raise ValueError('验证期间不能修改设备配置')
        with self.lock:
            self.result = {'state': 'idle', 'sessionId': None, 'section': None,
                           'message': '配置已变更，需重新验证', 'readings': None, 'phase': 'closed'}

    def close(self):
        self.closed = True
        self.cancelled.set()
        if self.thread:
            self.thread.join(timeout=1)
