"""Read-only sensor sessions with bounded delivery to the controller thread."""
import copy
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from collections import deque
from .modbus import ReadOnlyBus, open_serial
from .verification import probe

SECTIONS = ('tension', 'displacement')


def port_key(port):
    port = port.strip()
    if port.upper().startswith('COM'):
        return port.upper()
    return os.path.realpath(port).replace('/dev/cu.', '/dev/tty.', 1)


class SensorSession:
    def __init__(self, section, config, factory, capacity=256):
        self.section = section
        self.config = copy.deepcopy(config)
        self.factory = factory
        self.capacity = capacity
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.events = deque()
        self.last_monotonic = None
        self.stale_noted = False
        self.offset = 0
        self.sequence = 0
        self.status = dict(sessionId=uuid.uuid4().hex, section=section, source='hardware',
                           state='connecting', quality='unavailable', reading=None, lastValid=None,
                           error=None, startedAt=time.time(), finishedAt=None, zeroOffset=0,
                           configVersion=hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
                           staleAfterMs=max(1000, config['serial']['intervalMs'] * 3))
        self.thread = threading.Thread(target=self.run, name=f'sensor-{section}', daemon=True)

    def snapshot_locked(self):
        value = copy.deepcopy(self.status)
        if value['state'] == 'collecting' and self.last_monotonic is not None:
            value['ageMs'] = max(0, (time.monotonic() - self.last_monotonic) * 1000)
            if value['ageMs'] > value['staleAfterMs']:
                value.update(quality='stale', reading=None)
        if value['state'] != 'collecting':
            value['reading'] = None
        return value

    def snapshot(self):
        with self.lock:
            return self.snapshot_locked()

    def collect(self):
        with self.lock:
            snapshot = self.snapshot_locked()
            if snapshot['quality'] == 'stale' and not self.stale_noted and len(self.events) < self.capacity:
                self.enqueue_locked(dict(kind='quality', quality='stale', raw=None, value=None,
                                         error='等待响应期间数据已过期'))
                self.stale_noted = True
            events = list(self.events)
            self.events.clear()
            return events, snapshot

    def enqueue_locked(self, event):
        if len(self.events) >= self.capacity:
            raise ValueError('采集记录缓冲已满，终止本次采集；不静默丢弃数据')
        self.sequence += 1
        event.update(number=self.sequence, source='hardware', section=self.section,
                     sessionId=self.status['sessionId'], receivedAt=time.time())
        self.events.append(event)

    def zero(self):
        with self.lock:
            snapshot = self.snapshot_locked()
            if self.section != 'displacement' or snapshot['quality'] != 'valid' or snapshot['state'] != 'collecting':
                raise ValueError('仅可对正在采集且有效的位移数据设置软件相对零点')
            offset = snapshot['reading']['absoluteValue']
            self.enqueue_locked(dict(kind='zero', quality='unavailable', raw=None, value=None, zeroOffset=offset))
            self.offset = offset
            self.status.update(zeroOffset=offset, quality='unavailable', reading=None)

    def disconnect(self):
        self.cancelled.set()
        with self.lock:
            if self.status['state'] in ('connecting', 'collecting'):
                self.status.update(state='disconnecting', quality='unavailable', reading=None)

    def run(self):
        port = None
        error = None
        try:
            if self.cancelled.is_set():
                return
            port = self.factory(self.config['serial'])
            bus = ReadOnlyBus(port, self.config['serial'], self.cancelled)
            while not self.cancelled.is_set():
                started = time.monotonic()
                reading = probe(bus, self.section, self.config)
                with self.lock:
                    if self.cancelled.is_set():
                        break
                    sample = dict(kind='sample', quality='valid', **reading,
                                  absoluteValue=reading['value'], zeroOffset=self.offset)
                    sample['value'] -= self.offset
                    self.enqueue_locked(sample)
                    self.last_monotonic = time.monotonic()
                    self.stale_noted = False
                    self.status.update(state='collecting', quality='valid', reading=copy.deepcopy(sample),
                                       lastValid=copy.deepcopy(sample))
                # Skip missed deadlines instead of accumulating catch-up requests.
                delay = max(0, self.config['serial']['intervalMs'] / 1000 - (time.monotonic() - started))
                if self.cancelled.wait(delay):
                    break
        except Exception as exc:
            if not self.cancelled.is_set():
                error = str(exc)
                with self.lock:
                    self.status.update(state='disconnecting', quality='invalid', reading=None, error=error)
                logging.info('传感器采集终止 (%s): %s', self.section, exc)
        finally:
            if port is not None:
                try:
                    port.close()
                except Exception as exc:
                    error = f'关闭串口失败：{exc}'
            with self.lock:
                self.status.update(state='failed' if error else 'disconnected', quality='invalid' if error else 'unavailable',
                                   error=error, reading=None, finishedAt=time.time())


class SensorManager:
    def __init__(self, factory=open_serial):
        self.factory = factory
        self.sessions = {}
        self.closed = False

    def active(self):
        return any(session.thread.is_alive() for session in self.sessions.values())

    def connect(self, section, config):
        if self.closed or section not in SECTIONS:
            raise ValueError('不支持的传感器连接操作')
        existing = self.sessions.get(section)
        if existing and existing.thread.is_alive():
            raise ValueError('该传感器正在连接、采集或断开')
        for other in self.sessions.values():
            if other.thread.is_alive() and port_key(other.config['serial']['port']) == port_key(config['serial']['port']):
                raise ValueError('该串口已被其他类型传感器占用')
        session = SensorSession(section, config, self.factory)
        self.sessions[section] = session
        # The controller persists the session metadata before starting its I/O thread.
        return session

    def snapshot(self):
        return {section: session.snapshot() for section, session in self.sessions.items()}

    def disconnect(self, section=None):
        for key, session in self.sessions.items():
            if section is None or key == section:
                session.disconnect()

    def close(self):
        self.closed = True
        self.disconnect()
        for session in self.sessions.values():
            if session.thread.ident is not None:
                session.thread.join(timeout=1)
