"""JSONL v1: requests/responses + coalesced state events, heartbeat and EOF stop."""
import json
import logging
import queue
import sys
import threading
import time
import uuid
from collections import deque
from ..core.controller import Controller

MAX_LINE = 1024 * 1024


class Outbox:
    def __init__(self, session):
        self.session = session
        self.condition = threading.Condition()
        self.messages = deque()
        self.latest_state = None
        self.closed = False
        self.failed = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True, name='ipc-writer')
        self.thread.start()

    def put(self, message, state=False):
        # Serialize before the mutable controller state can change again.
        line = json.dumps({'v': 1, 'sessionId': self.session, **message}, ensure_ascii=False, allow_nan=False) + '\n'
        if len(line.encode('utf-8')) > MAX_LINE:
            raise RuntimeError('控制进程消息超限')
        with self.condition:
            if state:
                self.latest_state = line
            else:
                if len(self.messages) >= 256:
                    raise RuntimeError('控制进程消息队列已满')
                self.messages.append(line)
            self.condition.notify()

    def event(self, kind, data):
        self.put({'type': 'event', 'event': kind, 'data': data}, state=kind == 'state')

    def run(self):
        try:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: self.messages or self.latest_state or self.closed)
                    if self.messages:
                        line = self.messages.popleft()
                    elif self.latest_state:
                        line, self.latest_state = self.latest_state, None
                    else:
                        break
                sys.stdout.write(line)
                sys.stdout.flush()
        except (BrokenPipeError, OSError):
            self.failed.set()

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify()
        self.thread.join(timeout=1)


def serve(root):
    session = uuid.uuid4().hex
    outbox = Outbox(session)
    inbox = queue.PriorityQueue(maxsize=128)
    disconnected = threading.Event()

    def read_input():
        sequence = 0
        try:
            while True:
                raw = sys.stdin.buffer.readline(MAX_LINE + 1)
                if not raw:
                    break
                if len(raw) > MAX_LINE:
                    raise ValueError('请求消息超限')
                message = json.loads(raw)
                if not isinstance(message, dict) or message.get('v') != 1 or message.get('type') != 'request':
                    raise ValueError('不兼容的请求协议')
                if message.get('sessionId') != session:
                    continue
                method, params = message.get('method'), message.get('params', {})
                command = params.get('type') if isinstance(params, dict) else None
                urgent = method in ('system.shutdown', 'system.suspend') or (method == 'device.command' and command in ('emergency', 'stop'))
                priority = 0 if urgent else 1 if method == 'system.ping' else 2
                inbox.put_nowait((priority, sequence, message))
                sequence += 1
        except (ValueError, OSError, queue.Full):
            logging.exception('输入协议失败，停止控制端')
        finally:
            disconnected.set()

    controller = None
    try:
        controller = Controller(root, outbox.event)
        outbox.event('ready', controller.snapshot())
        threading.Thread(target=read_input, daemon=True, name='ipc-reader').start()
        heartbeat = time.monotonic()
        next_tick = heartbeat
        while not disconnected.is_set() and not outbox.failed.is_set():
            current = time.monotonic()
            if current - heartbeat > 10:
                logging.error('父进程心跳超时，停止控制端')
                break
            if current >= next_tick:
                controller.tick()
                next_tick = current + controller.config.value['sampleIntervalMs'] / 1000
            try:
                _, _, message = inbox.get(timeout=min(0.05, max(0, next_tick - time.monotonic())))
            except queue.Empty:
                continue
            request_id = message.get('id')
            if not isinstance(request_id, str) or len(request_id) > 100:
                raise ValueError('无效的请求编号')
            method, params = message.get('method'), message.get('params', {})
            if method == 'system.shutdown':
                controller.stop('收到退出指令，停止设备')
                outbox.put({'type': 'response', 'id': request_id, 'ok': True, 'result': None})
                break
            try:
                if method == 'system.ping':
                    heartbeat = time.monotonic()
                    result = {'online': True}
                else:
                    result = controller.request(method, params)
                outbox.put({'type': 'response', 'id': request_id, 'ok': True, 'result': result})
            except ValueError as exc:
                outbox.put({'type': 'response', 'id': request_id, 'ok': False, 'error': {'code': 'INVALID_OPERATION', 'message': str(exc)}})
            except Exception:
                logging.exception('控制操作失败，停止进程并使界面离线')
                raise
    finally:
        try:
            if controller:
                controller.close()
        finally:
            outbox.close()
