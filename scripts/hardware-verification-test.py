"""Deterministic verification tests; never opens real hardware."""
import copy
import json
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend' / 'src'))
from lab_controller.devices.modbus import ReadOnlyBus, crc16, frame, open_serial
from lab_controller.devices.verification import VerificationManager, probe
from lab_controller.storage.hardware import defaults


def response(station, registers):
    return frame(bytes([station, 3, len(registers) * 2]) + struct.pack('>' + 'H' * len(registers), *registers))


class FakePort:
    def __init__(self, reply):
        self.reply = reply
        self.pending = bytearray()
        self.writes = []
        self.closed = False

    def reset_input_buffer(self):
        self.pending.clear()

    def write(self, data):
        self.writes.append(data)
        self.pending.extend(self.reply(data))
        return len(data)

    def read(self, size):
        # Deliberately split every frame into tiny reads.
        chunk = bytes(self.pending[:2])
        del self.pending[:2]
        if not chunk:
            time.sleep(0.001)
        return chunk

    def close(self):
        self.closed = True


class VerificationTests(unittest.TestCase):
    def settings(self):
        return dict(port='TEST', baud=9600, bits=8, parity='N', stop=1, timeoutMs=50, intervalMs=100)

    def bus(self, reply):
        return ReadOnlyBus(FakePort(reply), self.settings(), threading.Event())

    def finish(self, manager):
        manager.thread.join(timeout=1)
        self.assertFalse(manager.active())
        return manager.snapshot()

    def config(self, section):
        config = copy.deepcopy(defaults()[section])
        config['serial'] = self.settings()
        if section == 'motors':
            config.update(motor1=1, motor2=2)
        else:
            config['station'] = 1
        return config

    def test_crc_and_wire_request(self):
        self.assertEqual(crc16(b'123456789'), 0x4B37)
        bus = self.bus(lambda request: response(1, [1234, 0]))
        self.assertEqual(bus.read(1, 0, 2), [1234, 0])
        self.assertEqual(bus.port.writes, [bytes.fromhex('01 03 00 00 00 02 C4 0B')])

    def test_serial_open_control_lines_and_failure_cleanup(self):
        port = Mock()

        def opened():
            self.assertIs(port.dtr, False)
            self.assertIs(port.rts, False)
            self.assertEqual(port.port, 'TEST')

        port.open.side_effect = opened
        constructor = Mock(return_value=port)
        with patch.dict(sys.modules, {'serial': SimpleNamespace(Serial=constructor)}):
            self.assertIs(open_serial(self.settings()), port)
            self.assertEqual(constructor.call_args.kwargs['timeout'], 0.05)
            self.assertEqual(constructor.call_args.kwargs['write_timeout'], 0.05)
            port.open.side_effect = OSError('busy')
            with self.assertRaises(OSError):
                open_serial(self.settings())
            port.close.assert_called_once()

    def test_noise_bad_crc_then_valid_split_frame(self):
        valid = response(1, [12])
        bad = valid[:-1] + bytes([valid[-1] ^ 1])
        bus = self.bus(lambda request: b'noise' + bad + response(2, [99]) + valid)
        self.assertEqual(bus.read(1, 4, 1), [12])
        self.assertEqual(len(bus.port.writes), 1)

    def test_protocol_error_frames_are_not_accepted(self):
        cases = [response(2, [1]), frame(bytes([1, 4, 2, 0, 1])),
                 response(1, [1, 2]), response(1, [1])[:-1]]
        for payload in cases:
            with self.subTest(payload=payload):
                bus = self.bus(lambda request: payload)
                with self.assertRaises(ValueError):
                    bus.read(1, 4, 1)
                self.assertEqual(len(bus.port.writes), 1)

    def test_exception_and_crc_failure(self):
        with self.assertRaisesRegex(ValueError, '0x02'):
            self.bus(lambda request: frame(bytes([1, 0x83, 2]))).read(1, 4, 1)
        bad = response(1, [1])[:-2] + b'\x00\x00'
        with self.assertRaisesRegex(ValueError, 'CRC'):
            self.bus(lambda request: bad).read(1, 4, 1)

    def test_broadcast_and_invalid_requests_never_sent(self):
        bus = self.bus(lambda request: b'')
        for args in [(0, 0, 1), (254, 0, 1), (1, -1, 1), (1, 0, 126), (1, 65535, 2)]:
            with self.assertRaises(ValueError):
                bus.read(*args)
        self.assertEqual(bus.port.writes, [])

    def test_tension_signed_and_displacement_formats(self):
        config = self.config('tension')
        config['decimals'] = 2
        self.assertEqual(probe(self.bus(lambda request: response(1, [65535, 65535])), 'tension', config)['value'], -0.01)
        config = self.config('displacement')
        config.update(model='p', lower=0, upper=700)
        self.assertEqual(probe(self.bus(lambda request: response(1, [2500])), 'displacement', config)['value'], 350)
        config.update(model='g', channel=3, reading='float')
        bus = self.bus(lambda request: response(1, [0x4248, 0]))
        self.assertEqual(probe(bus, 'displacement', config)['value'], 50)
        self.assertEqual(bus.port.writes[0][2:6], bytes.fromhex('00 0A 00 02'))
        with self.assertRaisesRegex(ValueError, '有效数值'):
            probe(self.bus(lambda request: response(1, [0x7F80, 0])), 'displacement', config)

    def test_two_motors_share_one_port_and_only_read(self):
        port = FakePort(lambda request: response(request[0], [16]))
        opened = []
        manager = VerificationManager(lambda settings: opened.append(settings) or port)
        manager.start('motors', self.config('motors'))
        result = self.finish(manager)
        self.assertEqual(result['state'], 'passed')
        self.assertEqual(len(opened), 1)
        self.assertEqual([data[0] for data in port.writes], [1, 2])
        self.assertTrue(all(data[1] == 3 for data in port.writes))
        self.assertTrue(port.closed)
        manager.close()

    def test_cancel_exclusive_and_invalidate(self):
        started = threading.Event()
        port = FakePort(lambda request: started.set() or b'')
        manager = VerificationManager(lambda settings: port)
        config = self.config('tension')
        config['serial']['timeoutMs'] = 60000
        manager.start('tension', config)
        self.assertTrue(started.wait(1))
        with self.assertRaises(ValueError):
            manager.start('tension', config)
        with self.assertRaises(ValueError):
            manager.invalidate()
        manager.cancel()
        self.assertEqual(self.finish(manager)['state'], 'cancelled')
        self.assertTrue(port.closed)
        manager.invalidate()
        self.assertEqual(manager.snapshot()['state'], 'idle')
        manager.close()
        with self.assertRaises(ValueError):
            manager.start('tension', config)

    def test_open_and_read_failures_release_resources(self):
        def failure(settings):
            raise OSError('port busy')
        manager = VerificationManager(failure)
        manager.start('tension', self.config('tension'))
        self.assertIn('port busy', self.finish(manager)['message'])
        manager.close()
        port = FakePort(lambda request: b'')
        manager = VerificationManager(lambda settings: port)
        manager.start('tension', self.config('tension'))
        self.assertEqual(self.finish(manager)['state'], 'failed')
        self.assertTrue(port.closed)
        manager.close()

    def test_controller_nonblocking_interlocks_and_saved_config(self):
        from lab_controller.core.controller import Controller
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            port = FakePort(lambda request: b'')
            controller.verification.factory = lambda settings: port
            try:
                config = defaults()
                config['tension'] = self.config('tension')
                config['tension']['serial']['timeoutMs'] = 60000
                controller.request('hardware.save', {'config': config})
                result = controller.request('hardware.verify', {'section': 'tension'})
                self.assertEqual(result['state'], 'checking')
                self.assertIn('state', controller.request('state.get', {}))
                self.assertFalse(any(controller.device.outputs.values()))
                with self.assertRaises(ValueError):
                    controller.request('device.command', {'type': 'toggle', 'device': 'motor1'})
                with self.assertRaises(ValueError):
                    controller.request('hardware.save', {'config': config})
                with self.assertRaises(ValueError):
                    controller.request('hardware.verify', {'section': 'lift'})
                controller.request('device.command', {'type': 'emergency'})
                self.assertEqual(self.finish(controller.verification)['state'], 'cancelled')
                for method in ('hardware.status', 'hardware.verify.cancel'):
                    with self.assertRaises(ValueError):
                        controller.request(method, {'unexpected': True})
            finally:
                controller.close()

    def test_jsonl_verification_does_not_block_heartbeat_or_shutdown(self):
        # A fake serial module exists only inside this disposable subprocess.
        source = '''
import sys, time
from types import SimpleNamespace
class Port:
    def __init__(self, **kwargs): pass
    def open(self): pass
    def close(self): pass
    def reset_input_buffer(self): pass
    def write(self, data): return len(data)
    def read(self, size):
        time.sleep(0.01)
        return b''
sys.modules['serial'] = SimpleNamespace(Serial=Port)
sys.path.insert(0, sys.argv.pop(1))
from lab_controller.__main__ import main
main()
'''
        backend = str(Path(__file__).resolve().parent.parent / 'backend' / 'src')
        with tempfile.TemporaryDirectory() as directory:
            child = subprocess.Popen([sys.executable, '-c', source, backend, '--data-dir', directory],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, encoding='utf-8')
            messages = queue.Queue()

            def reader():
                for line in child.stdout:
                    messages.put(json.loads(line))
                messages.put(None)

            threading.Thread(target=reader, daemon=True).start()

            def wait(predicate):
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    item = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                    if item is None:
                        self.fail('子进程提前退出：' + child.stderr.read())
                    if predicate(item):
                        return item
                self.fail('子进程响应超时')

            ident = 0

            def request(method, params=None):
                nonlocal ident
                ident += 1
                child.stdin.write(json.dumps({'v': 1, 'type': 'request', 'sessionId': session,
                                              'id': str(ident), 'method': method, 'params': params or {}}) + '\n')
                child.stdin.flush()
                reply = wait(lambda item: item.get('id') == str(ident))
                self.assertTrue(reply['ok'], reply)
                return reply['result']

            try:
                session = wait(lambda item: item.get('event') == 'ready')['sessionId']
                config = defaults()
                config['tension'] = self.config('tension')
                config['tension']['serial']['timeoutMs'] = 60000
                request('hardware.save', {'config': config})
                self.assertEqual(request('hardware.verify', {'section': 'tension'})['state'], 'checking')
                start = time.monotonic()
                self.assertTrue(request('system.ping')['online'])
                self.assertIn('state', request('state.get'))
                self.assertLess(time.monotonic() - start, 1)
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


if __name__ == '__main__':
    unittest.main()
