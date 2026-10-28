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


with tempfile.TemporaryDirectory(prefix='lab-controller-') as data:
    client = Client(data)
    try:
        assert not client.initial['state']['running']
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
print('PASS: Python IPC、模拟试验、配置校验、急停和 SQLite 重启保留')
