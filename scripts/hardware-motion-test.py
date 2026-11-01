"""Stop-only motion sessions using in-memory serial ports, never hardware."""
import copy
import json
import queue
import subprocess
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.core.controller import Controller
from lab_controller.devices.modbus import frame
from lab_controller.devices.motion import MotionManager, MotionSession, write_motor_stop
from lab_controller.devices.motion_protocol import motor_stop_request
from lab_controller.storage.hardware import defaults


class Port:
    def __init__(self, *, ack=True, read_reply=True, fault=False, short=False):
        self.ack, self.read_reply, self.fault, self.short = ack, read_reply, fault, short
        self.buffer = bytearray()
        self.writes = []
        self.closed = False
        self.threads = set()

    def reset_input_buffer(self):
        self.buffer.clear()

    def write(self, data):
        self.threads.add(threading.get_ident())
        self.writes.append(data)
        if len(data) == 8 and data[1] == 3 and self.read_reply:
            address, count = struct.unpack('>HH', data[2:6])
            words = [8 if self.fault else 0] if address == 4 else [0x1234, 0x5678]
            self.buffer.extend(frame(bytes([data[0], 3, count * 2]) + struct.pack('>' + 'H' * len(words), *words)))
        elif data[1] == 6 and self.ack:
            self.buffer.extend(data)
        return len(data) - 1 if self.short else len(data)

    def read(self, size):
        self.threads.add(threading.get_ident())
        result = bytes(self.buffer[:2])
        del self.buffer[:2]
        if not result:
            time.sleep(0.001)
        return result

    def close(self):
        self.threads.add(threading.get_ident())
        self.closed = True


def config():
    value = defaults()
    value['motors'].update(motor1=1, motor2=2)
    value['motors']['serial'].update(port='TEST-MOTORS', baud=9600, timeoutMs=50, intervalMs=10)
    value['lift']['serial'].update(port='TEST-LIFT', timeoutMs=50, intervalMs=10)
    return value


class MotionTests(unittest.TestCase):
    def wait(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.003)
        self.fail('等待运动诊断状态超时')

    def test_position_poll_order_raw_bits_and_no_motion_writes(self):
        port = Port()
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: all(session.snapshot()['readings'].get(target, {}).get('position')
                                  for target in ('motor1', 'motor2')))
            requests = [(packet[0], *struct.unpack('>HH', packet[2:6])) for packet in port.writes]
            self.assertEqual(requests[:4], [(1, 4, 1), (1, 8, 2), (2, 4, 1), (2, 8, 2)])
            self.assertEqual(port.writes[1].hex(), '01030008000245c9')
            for reading in session.snapshot()['readings'].values():
                position = reading['position']
                self.assertEqual(position['rawUnsigned'], 0x12345678)
                self.assertEqual(position['quality'], 'valid')
                self.assertFalse(position['interpretationVerified'])
                self.assertNotIn('positionMm', position)
            self.assertTrue(all(packet[1] == 3 for packet in port.writes))
        finally:
            manager.close()

    def test_position_and_status_freshness_are_independent(self):
        session = MotionSession('motors', config()['motors'], lambda settings: None)
        session.status['state'] = 'monitoring'
        session.update_reading('motor1', dict(raw=0))
        session.last_received['motor1'] -= 2
        session.update_position('motor1', [65535, 65535])
        reading = session.snapshot()['readings']['motor1']
        self.assertEqual(reading['quality'], 'stale')
        self.assertEqual(reading['position']['quality'], 'valid')
        self.assertEqual(reading['position']['rawUnsigned'], 0xFFFFFFFF)
        session.position_received['motor1'] -= 2
        position_time = session.status['readings']['motor1']['position']['receivedAt']
        session.update_reading('motor1', dict(raw=16))
        reading = session.snapshot()['readings']['motor1']
        self.assertEqual(reading['quality'], 'valid')
        self.assertEqual(reading['position']['quality'], 'stale')
        self.assertEqual(reading['position']['receivedAt'], position_time)
        reading['position']['rawUnsigned'] = 0
        self.assertEqual(session.snapshot()['readings']['motor1']['position']['rawUnsigned'], 0xFFFFFFFF)
        session.status['state'] = 'disconnecting'
        self.assertEqual(session.snapshot()['readings']['motor1']['quality'], 'stale')

    def test_position_timeout_fails_closed_without_retry(self):
        port = Port()
        write = port.write
        def missing_position(data):
            count = write(data)
            if data[1] == 3 and data[3] == 8:
                port.buffer.clear()
            return count
        port.write = missing_position
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: not manager.active())
            status = session.snapshot()
            self.assertEqual(status['state'], 'failed')
            self.assertTrue(status['faultLatched'])
            self.assertEqual(status['readings']['motor1']['quality'], 'stale')
            self.assertNotIn('position', status['readings']['motor1'])
            self.assertEqual(len(port.writes), 2)
            self.assertTrue(port.closed)
        finally:
            manager.close()

    def test_emergency_preempts_position_wait_without_publishing_partial_feedback(self):
        port = Port()
        waiting = threading.Event()
        write = port.write
        def missing_position(data):
            count = write(data)
            if data[1] == 3 and data[3] == 8:
                port.buffer.clear()
                waiting.set()
            return count
        port.write = missing_position
        manager = MotionManager(lambda settings: port)
        settings = config()['motors']
        settings['serial']['timeoutMs'] = 60000
        try:
            session = manager.connect('motors', settings)
            self.assertTrue(waiting.wait(1))
            start = time.monotonic()
            manager.stop(emergency=True, close=True)
            self.wait(lambda: not manager.active())
            self.assertLess(time.monotonic() - start, 1)
            self.assertNotIn('position', session.snapshot()['readings']['motor1'])
            self.assertEqual(port.writes[2:], [motor_stop_request(1, emergency=True), motor_stop_request(2, emergency=True)])
        finally:
            manager.close()

    def test_invalid_position_responses_never_publish_or_retry(self):
        responses = [frame(bytes.fromhex('0103020001')), frame(bytes.fromhex('02030400001388')),
                     bytes.fromhex('010304000013880000'), frame(bytes.fromhex('018302'))]
        for response in responses:
            with self.subTest(response=response.hex()):
                port = Port()
                write = port.write
                def invalid(data):
                    count = write(data)
                    if data[1] == 3 and data[3] == 8:
                        port.buffer[:] = response
                    return count
                port.write = invalid
                manager = MotionManager(lambda settings: port)
                try:
                    session = manager.connect('motors', config()['motors'])
                    self.wait(lambda: not manager.active())
                    self.assertEqual(session.snapshot()['state'], 'failed')
                    self.assertNotIn('position', session.snapshot()['readings']['motor1'])
                    self.assertEqual(len(port.writes), 2)
                finally:
                    manager.close()

    def test_connect_only_reads_two_stations_one_owner(self):
        port = Port()
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: len(session.snapshot()['readings']) == 2)
            self.assertEqual({packet[0] for packet in port.writes}, {1, 2})
            self.assertTrue(all(packet[1] == 3 for packet in port.writes))
            self.assertFalse(session.snapshot()['motionAllowed'])
            manager.stop(close=True)
            self.wait(lambda: not manager.active())
            writes = [packet for packet in port.writes if packet[1] == 6]
            self.assertEqual(writes, [motor_stop_request(1), motor_stop_request(2)])
            self.assertTrue(port.closed)
            self.assertEqual(len(port.threads), 1)
            self.assertTrue(all(not value['motionConfirmed'] for value in session.snapshot()['commands'].values()))
        finally:
            manager.close()

    def test_bounded_queue_emergency_wins_without_opening(self):
        session = MotionSession('motors', config()['motors'], lambda settings: self.fail('不得打开'))
        for _ in range(20):
            session.stop()
        session.stop(emergency=True)
        session.stop()
        self.assertEqual(len(session.pending), 2)
        self.assertTrue(all(command['emergency'] for command in session.pending.values()))
        session.stop(close=True)
        session.thread.start()
        session.thread.join(1)
        self.assertFalse(session.thread.is_alive())
        self.assertTrue(all(command['state'] == 'unknown' for command in session.snapshot()['commands'].values()))

    def test_preempt_long_read_for_emergency_and_close(self):
        port = Port(read_reply=False)
        manager = MotionManager(lambda settings: port)
        settings = config()['motors']
        settings['serial']['timeoutMs'] = 60000
        try:
            manager.connect('motors', settings)
            self.wait(lambda: bool(port.writes))
            started = time.monotonic()
            manager.stop(emergency=True, close=True)
            self.wait(lambda: not manager.active())
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual([data for data in port.writes if data[1] == 6],
                             [motor_stop_request(1, emergency=True), motor_stop_request(2, emergency=True)])
        finally:
            manager.close()

    def test_stop_arriving_between_queue_check_and_close_check_is_sent(self):
        port = Port()
        session = MotionSession('motors', config()['motors'], lambda settings: port)
        original = session.take_stop
        fired = False
        def take():
            nonlocal fired
            result = original()
            if not fired and result is None:
                fired = True
                session.stop(close=True)
            return result
        session.take_stop = take
        session.thread.start()
        session.thread.join(1)
        self.assertFalse(session.thread.is_alive())
        self.assertEqual(port.writes, [motor_stop_request(1), motor_stop_request(2)])

    def test_disconnect_while_open_is_blocked_stops_after_open_returns(self):
        port = Port()
        entered, release = threading.Event(), threading.Event()
        def factory(settings):
            entered.set()
            release.wait(3)
            return port
        manager = MotionManager(factory)
        try:
            session = manager.connect('motors', config()['motors'])
            self.assertTrue(entered.wait(1))
            manager.stop(close=True)
            self.assertEqual(session.snapshot()['state'], 'disconnecting')
            self.assertTrue(manager.active())
            self.assertEqual(port.writes, [])
            release.set()
            self.wait(lambda: not manager.active())
            self.assertEqual(port.writes, [motor_stop_request(1), motor_stop_request(2)])
            self.assertTrue(port.closed)
        finally:
            release.set()
            manager.close()

    def test_new_emergency_interrupts_ordinary_ack_wait(self):
        port = Port(ack=False)
        write = port.write
        def selective(data):
            count = write(data)
            if data[1] == 6 and data[5] == 0x40:
                port.buffer.extend(data)
            return count
        port.write = selective
        manager = MotionManager(lambda settings: port)
        settings = config()['motors']
        settings['serial']['timeoutMs'] = 60000
        try:
            session = manager.connect('motors', settings)
            self.wait(lambda: len(session.snapshot()['readings']) == 2)
            manager.stop()
            self.wait(lambda: any(data[1] == 6 for data in port.writes))
            start = time.monotonic()
            manager.stop(emergency=True, close=True)
            self.wait(lambda: not manager.active())
            self.assertLess(time.monotonic() - start, 0.5)
            stops = [data for data in port.writes if data[1] == 6]
            self.assertEqual(len(stops), 3)
            self.assertEqual(set(stops[1:]), {motor_stop_request(1, emergency=True), motor_stop_request(2, emergency=True)})
        finally:
            manager.close()

    def test_write_timeout_short_write_exception_no_retry(self):
        forbidden = Port()
        with self.assertRaises(ValueError):
            write_motor_stop(forbidden, frame(bytes.fromhex('0106004e0008')), 0.02, threading.Event())
        self.assertEqual(forbidden.writes, [])
        for port in (Port(ack=False), Port(short=True)):
            with self.assertRaises(ValueError):
                write_motor_stop(port, motor_stop_request(1), 0.02, threading.Event())
            self.assertEqual(len(port.writes), 1)
        port = Port()
        original = port.write
        def exception(data):
            original(data)
            raise OSError('adapter lost')
        port.write = exception
        with self.assertRaises(OSError):
            write_motor_stop(port, motor_stop_request(1), 0.02, threading.Event())
        self.assertEqual(len(port.writes), 1)

    def test_missing_ack_stays_unknown_then_other_motor_still_stops(self):
        port = Port(ack=False)
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: len(session.snapshot()['readings']) == 2)
            manager.stop(close=True)
            self.wait(lambda: not manager.active())
            self.assertEqual(len([data for data in port.writes if data[1] == 6]), 2)
            self.assertTrue(all(command['state'] == 'unknown' for command in session.snapshot()['commands'].values()))
            self.assertTrue(session.snapshot()['faultLatched'])
        finally:
            manager.close()

    def test_feedback_fault_latches_and_stops_once(self):
        port = Port(fault=True)
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: len([data for data in port.writes if data[1] == 6]) == 2)
            self.assertTrue(session.snapshot()['faultLatched'])
            self.wait(lambda: len([data for data in port.writes if data[1] == 3]) >= 4)
            self.assertEqual(len([data for data in port.writes if data[1] == 6]), 2)
        finally:
            manager.close()

    def test_lift_listens_without_query_and_never_claims_stopped(self):
        port = Port()
        port.buffer.extend(bytes.fromhex('AA07013031322E33FF'))
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('lift', config()['lift'])
            self.wait(lambda: bool(session.snapshot()['readings']))
            self.assertEqual(port.writes, [])
            self.assertEqual(session.snapshot()['readings']['lift']['positionMm'], 123)
            with session.lock:
                session.last_received['lift'] -= 2
            self.assertEqual(session.snapshot()['readings']['lift']['quality'], 'stale')
            manager.stop('lift', close=True)
            self.wait(lambda: not manager.active())
            self.assertEqual(port.writes, [bytes.fromhex('AA030400FF')])
            self.assertEqual(session.snapshot()['commands']['lift']['state'], 'sent')
            self.assertFalse(session.snapshot()['commands']['lift']['motionConfirmed'])
        finally:
            manager.close()

    def test_rejected_interfaces_stations_baud_and_alias_conflicts(self):
        manager = MotionManager(lambda settings: Port())
        try:
            for section, patch in [('lift', {'interface': 'RS485'}), ('motors', {'motor1': 254}),
                                   ('motors', {'motor1': True}), ('motors', {'motor2': 1})]:
                settings = config()[section]
                settings.update(patch)
                with self.assertRaises(ValueError):
                    manager.connect(section, settings)
            for section in ('motors', 'lift'):
                settings = config()[section]
                settings['serial']['baud'] = 1
                with self.assertRaises(ValueError):
                    manager.connect(section, settings)
            settings = config()['motors']
            settings['serial']['port'] = '/dev/cu.TEST'
            manager.connect('motors', settings)
            other = config()['lift']
            other['serial']['port'] = '/dev/tty.TEST'
            with self.assertRaises(ValueError):
                manager.connect('lift', other)
            with self.assertRaises(ValueError):
                manager.connect('motors', settings)
        finally:
            manager.close()

    def test_read_failure_invalidates_feedback_and_does_not_reconnect(self):
        port = Port(read_reply=False)
        calls = []
        def factory(settings):
            calls.append(copy.deepcopy(settings))
            return port
        manager = MotionManager(factory)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: not manager.active())
            self.assertEqual(session.snapshot()['state'], 'failed')
            self.assertTrue(session.snapshot()['faultLatched'])
            self.assertTrue(port.closed)
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(port.writes), 1)
        finally:
            manager.close()

    def test_failure_invalidates_immediately_while_os_close_is_blocked(self):
        port = Port()
        entered, release = threading.Event(), threading.Event()
        close = port.close
        def blocked_close():
            entered.set()
            release.wait(3)
            close()
        port.close = blocked_close
        manager = MotionManager(lambda settings: port)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: all(session.snapshot()['readings'].get(target, {}).get('position')
                                  for target in ('motor1', 'motor2')))
            port.read_reply = False
            self.assertTrue(entered.wait(1))
            status = session.snapshot()
            self.assertEqual(status['state'], 'disconnecting')
            self.assertTrue(status['faultLatched'])
            self.assertTrue(status['error'])
            self.assertTrue(all(reading['quality'] == 'stale' for reading in status['readings'].values()))
            self.assertTrue(all(reading['position']['quality'] == 'stale' for reading in status['readings'].values()))
            self.assertTrue(manager.active())
            with self.assertRaises(ValueError):
                manager.connect('motors', config()['motors'])
        finally:
            release.set()
            manager.close()

    def test_controller_interlocks_lock_and_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            ports = []
            def factory(settings):
                port = Port()
                ports.append(port)
                return port
            controller.motion.factory = factory
            try:
                value = config()
                controller.request('hardware.save', {'config': value})
                controller.request('hardware.motion.connect', {'section': 'motors'})
                self.wait(lambda: bool(controller.motion.snapshot()['motors']['readings']))
                for method, params in [('hardware.save', {'config': value}),
                        ('hardware.verify', {'section': 'motors'}),
                        ('hardware.sensors.connect', {'section': 'tension'}),
                        ('device.command', {'type': 'toggle', 'device': 'motor1'}),
                        ('hardware.motion.start', {'section': 'motors'}),
                        ('hardware.motion.stop', {'section': 'motors', 'emergency': 1})]:
                    with self.assertRaises(ValueError):
                        controller.request(method, params)
                self.assertFalse(any(controller.state['devices'].values()))
                self.assertEqual(controller.records.list(controller.state['database']), [])
                controller.request('system.motion.lock', {})
                self.wait(lambda: not controller.motion.active())
                controller.poll_hardware()
                self.assertTrue(any('停止结果 acknowledged' in log['message'] for log in controller.records.logs()))
                self.assertTrue(ports[0].closed)
                self.assertEqual(controller.request('hardware.motion.status', {})['motors']['state'], 'disconnected')
            finally:
                controller.close()

    def test_open_failure_and_audit_overflow_are_explicit(self):
        def fail(settings):
            raise OSError('no serial device')
        manager = MotionManager(fail)
        try:
            session = manager.connect('motors', config()['motors'])
            self.wait(lambda: not manager.active())
            self.assertEqual(session.snapshot()['state'], 'failed')
            self.assertIn('no serial device', session.snapshot()['error'])
        finally:
            manager.close()
        session = MotionSession('motors', config()['motors'], lambda settings: Port())
        with session.lock:
            for _ in range(130):
                session.note_locked('test audit')
        self.assertEqual(len(session.audit), 128)
        self.assertEqual(session.snapshot()['auditDropped'], 2)
        session.thread.start()
        session.thread.join(1)
        self.assertEqual(session.snapshot()['state'], 'failed')
        self.assertIn('审计缓冲溢出', session.snapshot()['error'])

    def test_jsonl_long_read_does_not_block_ping_lock_or_shutdown(self):
        source = '''
import sys, time
from types import SimpleNamespace
class Port:
    def __init__(self, **kwargs): self.buffer = bytearray()
    def open(self): pass
    def close(self): pass
    def reset_input_buffer(self): self.buffer.clear()
    def write(self, data):
        if data[1] == 6: self.buffer.extend(data)
        return len(data)
    def read(self, size):
        time.sleep(0.01)
        result = bytes(self.buffer)
        self.buffer.clear()
        return result
sys.modules['serial'] = SimpleNamespace(Serial=Port)
sys.path.insert(0, sys.argv.pop(1))
from lab_controller.__main__ import main
main()
'''
        backend = str(Path(__file__).resolve().parents[1] / 'backend' / 'src')
        with tempfile.TemporaryDirectory() as directory:
            child = subprocess.Popen([sys.executable, '-c', source, backend, '--data-dir', directory],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, encoding='utf-8')
            messages = queue.Queue()
            def read():
                for line in child.stdout:
                    messages.put(json.loads(line))
                messages.put(None)
            threading.Thread(target=read, daemon=True).start()
            def receive(predicate):
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    message = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                    self.assertIsNotNone(message, 'JSONL 子进程意外退出')
                    if predicate(message):
                        return message
                self.fail('JSONL 响应超时')
            ident = 0
            def request(method, params=None):
                nonlocal ident
                ident += 1
                child.stdin.write(json.dumps(dict(v=1, type='request', sessionId=session,
                    id=str(ident), method=method, params=params or {})) + '\n')
                child.stdin.flush()
                reply = receive(lambda item: item.get('id') == str(ident))
                self.assertTrue(reply['ok'], reply)
                return reply['result']
            try:
                session = receive(lambda item: item.get('event') == 'ready')['sessionId']
                value = config()
                value['motors']['serial']['timeoutMs'] = 60000
                request('hardware.save', {'config': value})
                request('hardware.motion.connect', {'section': 'motors'})
                start = time.monotonic()
                self.assertTrue(request('system.ping')['online'])
                self.assertIn('state', request('state.get'))
                request('system.motion.lock')
                self.assertLess(time.monotonic() - start, 1)
                status = request('hardware.motion.status')['motors']
                self.assertTrue(status['faultLatched'])
                request('system.shutdown')
                child.stdin.close()
                child.wait(timeout=3)
                self.assertEqual(child.returncode, 0, child.stderr.read())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
                for stream in (child.stdin, child.stdout, child.stderr):
                    stream.close()

    def test_priority_lock_invalidates_an_older_queued_connection(self):
        from lab_controller.ipc import server
        inbox = queue.PriorityQueue()
        inbox.put((2, 0, dict(id='connect', method='hardware.motion.connect', params={'section': 'motors'})))
        inbox.put((0, 1, dict(id='lock', method='system.motion.lock', params={})))
        # Drain the fixture only after the lock and obsolete connection were dispatched.
        inbox.put((3, 2, dict(id='exit', method='system.shutdown', params={})))
        calls, responses = [], []
        controller = SimpleNamespace(config=SimpleNamespace(value={'sampleIntervalMs': 100}),
            snapshot=lambda: {}, publish_array=lambda: None, tick=lambda: None,
            request=lambda method, params: calls.append(method), stop=lambda reason: None, close=lambda: None)
        outbox = SimpleNamespace(failed=threading.Event(), event=lambda *args: None,
                                 put=responses.append, close=lambda: None)
        with patch.object(server, 'Controller', return_value=controller), \
                patch.object(server, 'Outbox', return_value=outbox), \
                patch.object(server.queue, 'PriorityQueue', return_value=inbox), \
                patch.object(server.threading, 'Thread'):
            server.serve(Path('.'))
        self.assertEqual(calls, ['system.motion.lock'])
        rejected = next(response for response in responses if response['id'] == 'connect')
        self.assertFalse(rejected['ok'])
        self.assertIn('作废', rejected['error']['message'])


if __name__ == '__main__':
    unittest.main()
