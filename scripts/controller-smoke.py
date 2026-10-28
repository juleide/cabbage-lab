"""One short integration check: real JSONL subprocess + SQLite persistence."""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Client:
    def __init__(self, data):
        env = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend' / 'src'), 'PYTHONUNBUFFERED': '1', 'PYTHONUTF8': '1'}
        self.child = subprocess.Popen([sys.executable, '-m', 'lab_controller', '--data-dir', data],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, encoding='utf-8', env=env)
        self.messages = queue.Queue()
        self.session = None
        self.counter = 0

        def reader():
            for line in self.child.stdout:
                self.messages.put(json.loads(line))
            self.messages.put(None)
        threading.Thread(target=reader, daemon=True).start()
        message = self.wait(lambda item: item.get('event') == 'ready')
        self.session = message['sessionId']
        self.initial = message['data']

    def wait(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if message is None:
                raise RuntimeError(self.child.stderr.read())
            if predicate(message):
                return message
        raise TimeoutError('控制端响应超时')

    def request(self, method, params=None):
        self.counter += 1
        ident = str(self.counter)
        self.child.stdin.write(json.dumps({'v': 1, 'type': 'request', 'sessionId': self.session,
                                          'id': ident, 'method': method, 'params': params or {}}) + '\n')
        self.child.stdin.flush()
        response = self.wait(lambda message: message.get('type') == 'response' and message.get('id') == ident)
        if not response['ok']:
            raise ValueError(response['error']['message'])
        return response['result']

    def command(self, kind, **params):
        return self.request('device.command', {'type': kind, **params})

    def close(self):
        if self.child.poll() is None:
            try:
                self.request('system.shutdown')
            finally:
                self.child.stdin.close()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait()
        assert self.child.returncode == 0, self.child.stderr.read()


# Short parser checks in the existing smoke command, not a separate test suite.
sys.path.insert(0, str(ROOT / 'backend' / 'src'))
from lab_controller.array.protocol import FrameAssembler, RowDecoder, simulation_crc
from lab_controller.array.acquisition import verify_simulated
from lab_controller.array.simulated import make_packets
from lab_controller.array.processing import BaselineCorrection, statistics

assert simulation_crc(b'123456789') == 0x29B1
binary = make_packets(255, 'press', 0, False)
decoder = RowDecoder(verify_simulated)
rows = []
for offset in range(0, len(binary), 173):
    rows.extend(decoder.feed((b'noise' if offset == 0 else b'') + binary[offset:offset + 173]))
assert len(rows) == 64 and len(rows[0].values) == 64
# Documented wire permutation must be undone, not drawn in arrival order.
for index in range(64):
    column = (index % 8) * 8 + index // 8
    assert rows[0].values[column] == int.from_bytes(binary[6 + index * 2:8 + index * 2], 'big')
assembler = FrameAssembler()
assert assembler.feed(rows[0], 0) is None
assert assembler.feed(rows[0], 0.01) is None and assembler.duplicate_rows == 1
for row in reversed(rows[1:]):
    values = assembler.feed(row, 0.02)
assert len(values) == 4096
wrapped = list(decoder.feed(make_packets(0, 'grip', 0, False)))
for row in wrapped:
    next_values = assembler.feed(row, 0.04)
assert len(next_values) == 4096 and assembler.valid_frames == 2
broken = bytearray(binary[:136])
broken[10] ^= 1
assert not list(decoder.feed(broken)) and decoder.crc_errors == 1
partial = FrameAssembler()
partial.feed(rows[0], 0)
partial.expire(0.6)
assert partial.dropped_frames == 1
assert partial.feed(rows[1], 0.61) is None

# Deterministic baseline check: raw input stays untouched, signed display values survive.
correction = BaselineCorrection()
original = [100] * 4096
correction.start(0)
for index in range(25):
    result = correction.apply(original, index * 0.04)
assert correction.status()['active'] and result == [0] * 4096
assert original == [100] * 4096
assert correction.apply([90] * 4096, 1.1) == [-10] * 4096
correction.start(2)
correction.expire(5.1)
assert correction.status()['active'] and correction.status()['error']
correction.clear()
assert correction.apply(original, 6) == original and not correction.status()['active']
assert statistics([3, 1, 3] + [0] * 4093)['maxColumn'] == 0

with tempfile.TemporaryDirectory(prefix='lab-controller-') as data:
    client = Client(data)
    try:
        assert not client.initial['state']['running']
        frame_event = client.wait(lambda message: message.get('event') == 'pressure.frame')
        assert len(frame_event['data']['values']) == 4096
        assert frame_event['data']['source'] == 'simulation'
        # Array updates are independent of slow scalar sampling.
        slow = {**client.initial['config'], 'sampleIntervalMs': 5000}
        client.request('config.update', {'config': slow})
        before = time.monotonic()
        client.wait(lambda message: message.get('event') == 'pressure.frame')
        assert time.monotonic() - before < 1
        status = client.request('pressure.mode', {'mode': 'grip'})
        frame = client.wait(lambda message: message.get('event') == 'pressure.frame'
                            and message['data']['generation'] == status['generation'])['data']
        assert frame['mode'] == 'grip'
        client.command('zero')
        raw_frame = client.wait(lambda message: message.get('event') == 'pressure.frame')['data']
        assert any(raw_frame['values']), '标量置零不得清空原始阵列'
        client.request('pressure.zero.start')
        try:
            client.command('toggle', device='motor1')
            raise AssertionError('修正收集中不得启动电机')
        except ValueError:
            pass
        corrected = client.wait(lambda message: message.get('event') == 'pressure.frame'
                                and message['data']['correction']['active'])['data']
        assert corrected['correction']['collected'] == 25
        assert all(isinstance(value, int) for value in corrected['values'])
        assert max(abs(value) for value in corrected['displayValues']) < 300
        client.request('pressure.zero.clear')
        restored = client.wait(lambda message: message.get('event') == 'pressure.frame'
                              and not message['data']['correction']['active'])['data']
        assert restored['displayValues'] == restored['values']
        assert client.request('pressure.status')['diagnostics']['captureFps'] > 0
        config = {**client.initial['config'], 'defaultPressure': 0.42, 'recordPrefix': 'LAB'}
        client.request('config.update', {'config': config})
        client.command('initialize')
        client.command('toggle', device='motor1')
        client.command('toggle', device='motor2')
        client.command('run')
        time.sleep(0.25)
        snapshot = client.request('records.snapshot')
        assert snapshot['count'] > 0
        assert client.request('records.read', {'runId': snapshot['runId'], 'offset': 0, 'limit': 1})[0]['pressure'] == 0.42
        try:
            client.request('config.update', {'config': config})
            raise AssertionError('运行中不应允许修改配置')
        except ValueError:
            pass
        client.command('emergency')
        state = client.request('state.get')['state']
        assert state['stopped'] and not state['running'] and not any(state['devices'].values())
        assert state['array']['paused']
        try:
            client.command('toggle', device='motor1')
            raise AssertionError('急停后不应启动执行机构')
        except ValueError:
            pass
        client.command('reset')
    finally:
        client.close()
    client = Client(data)
    try:
        assert client.initial['config']['defaultPressure'] == 0.42
        assert client.initial['state']['sampleCount'] >= snapshot['count']
        assert not any(client.initial['state']['devices'].values())
        assert client.request('records.list')[0]['id'] == snapshot['runId']
    finally:
        client.close()
print('PASS: 阵列拆包/CRC/重排/循环、独立刷新、基线修正/取消/互锁、暂停、IPC 与 SQLite 保留')
