"""Minimal motor control tests, using offline frames and fake ports only."""
import copy
import struct
import sys
import threading
import time
import queue
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend' / 'src'))
from lab_controller.devices.modbus import frame
from lab_controller.devices.motor_protocol import jog_setup, jog_trigger, jog_ack, motor_speed
from lab_controller.storage.hardware import motor_operation
from lab_controller.storage.hardware import defaults
from lab_controller.devices.motion import MotionManager
from lab_controller.devices.motor_control import MotorControlSession
from lab_controller.devices.motion_protocol import motor_status
from lab_controller.core.controller import Controller


def operation(**changes):
    value = dict(direction=1, speedRpm=200, maxSpeedRpm=200,
                 accelerationMs=100, decelerationMs=200, maxRunMs=5000)
    value.update(changes)
    return value


class MotorCodecTests(unittest.TestCase):
    def test_setup_order_and_manual_speed_vector(self):
        value = operation()
        before = copy.deepcopy(value)
        requests = jog_setup(1, value)
        self.assertEqual(requests[0].hex(), '0106003000c88853')
        self.assertEqual([struct.unpack('>BBHH', data[:-2]) for data in requests],
                         [(1, 6, 0x30, 200), (1, 6, 0x31, 100), (1, 6, 0x32, 200)])
        self.assertEqual(value, before)
        self.assertEqual(jog_trigger(1).hex(), '0106004e0008e81b')

    def test_reverse_speed_two_complement_and_extremes(self):
        for station in (1, 247):
            for sign in (-1, 1):
                for speed in (1, 3000):
                    value = operation()
                    value.update(direction=sign, speedRpm=speed, maxSpeedRpm=3000)
                    request = jog_setup(station, value)[0]
                    self.assertEqual(motor_speed(int.from_bytes(request[4:6], 'big')), sign * speed)
                    self.assertEqual(request[0], station)
                    self.assertEqual(jog_ack(request, request)['physicalMotionConfirmed'], False)

    def test_no_incomplete_forged_parameters_or_invalid_stations(self):
        for station in (0, 248, 254, True, 1.0, '1'):
            with self.assertRaises(ValueError):
                jog_setup(station, operation())
            with self.assertRaises(ValueError):
                jog_trigger(station)
        for value in (motor_operation(), dict(operation(), canExecute=True),
                      dict(operation(), direction=0), dict(operation(), speedRpm=201),
                      dict(operation(), accelerationMs=0), dict(operation(), maxRunMs=True)):
            with self.assertRaises(ValueError):
                jog_setup(1, value)

    def test_echo_strict_and_exception_not_success(self):
        request = jog_trigger(2)
        for response in (request[:-1], request[:-1] + b'\x00', jog_trigger(1),
                         frame(bytes.fromhex('028603')), frame(bytes.fromhex('0206004e0020'))):
            with self.assertRaises(ValueError):
                jog_ack(request, response)
        for request in (frame(bytes.fromhex('0206004f0500')), frame(bytes.fromhex('020600370001')),
                        frame(bytes.fromhex('020600300000')), frame(bytes.fromhex('020600310000')),
                        frame(bytes.fromhex('0206004e0001')), frame(bytes.fromhex('02060030ffff'))[:-1]):
            with self.assertRaises(ValueError):
                jog_ack(request, request)
        request = jog_setup(2, operation())[0]
        wrong_value = frame(request[:4] + b'\x00\x01')
        with self.assertRaises(ValueError):
            jog_ack(request, wrong_value)

    def test_speed_signed_int16(self):
        for word, expected in ((0, 0), (0x7FFF, 32767), (0x8000, -32768), (0xFFFF, -1), (0xFF38, -200)):
            self.assertEqual(motor_speed(word), expected)
        for bad in (True, -1, 65536, 1.0, '1'):
            with self.assertRaises(ValueError):
                motor_speed(bad)


class JogPort:
    def __init__(self):
        self.buffer = bytearray()
        self.writes = []
        self.speeds = {1: 0, 2: 0}
        self.parameters = {}
        self.closed = False
        self.hook = None
        self.owners = set()

    def reset_input_buffer(self):
        self.buffer.clear()

    def write(self, packet):
        self.owners.add(threading.get_ident())
        self.writes.append(packet)
        station, function, address, value = struct.unpack('>BBHH', packet[:-2])
        if function == 3:
            word = (16 | (4 if self.speeds[station] else 0)) if address == 4 else self.speeds[station] & 65535
            self.buffer.extend(frame(bytes([station, 3, 2]) + struct.pack('>H', word)))
        else:
            self.parameters[station, address] = value
            if address == 0x4e:
                self.speeds[station] = motor_speed(self.parameters[station, 0x30]) if value == 8 else 0
            self.buffer.extend(packet)
        if self.hook:
            self.hook(packet)
        return len(packet)

    def read(self, size):
        self.owners.add(threading.get_ident())
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        if not result:
            time.sleep(.001)
        return result

    def close(self):
        self.owners.add(threading.get_ident())
        self.closed = True


def settings():
    value = defaults()['motors']
    value.update(motor1=1, motor2=2)
    value['serial'].update(port='FAKE-JOG', baud=115200, timeoutMs=50, intervalMs=10)
    value['operation'] = dict(motor1=operation(), motor2=operation(direction=-1))
    return value


class MotorSessionTests(unittest.TestCase):
    def wait(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.003)
        self.fail('等待假串口电机状态超时')

    def connect(self):
        port = JogPort()
        manager = MotionManager(lambda config: port)
        self.addCleanup(manager.close)
        session = manager.connect('motors', settings(), control=True)
        self.wait(lambda: all(axis['canStart'] for axis in session.snapshot()['axes'].values()))
        return session, port, manager

    def start(self, session, target='motor1'):
        status = session.snapshot()
        session.start(target, status['sessionId'], status['configVersion'])

    def detached(self):
        session = MotorControlSession(settings(), lambda config: None)
        session.status['state'] = 'monitoring'
        for target in session.targets:
            session.update_reading(target, dict(raw=16, **motor_status(16)))
            session.update_speed(target, 0)
        return session

    def test_connect_is_read_only_and_owner_is_shared(self):
        session, port, manager = self.connect()
        self.assertTrue(all(packet[1] == 3 for packet in port.writes))
        self.assertEqual({int.from_bytes(p[2:4], 'big') for p in port.writes}, {4, 10})
        with self.assertRaises(ValueError):
            manager.connect('motors', settings())
        self.assertEqual(session.snapshot()['purpose'], 'control')
        self.assertEqual(len(port.owners), 1)

    def test_both_directions_and_targeted_stop(self):
        session, port, manager = self.connect()
        for target in session.targets:
            self.start(session, target)
            self.wait(lambda: session.snapshot()['axes'][target]['state'] == 'running')
        for station, speed in ((1, 200), (2, -200)):
            packets = [p for p in port.writes if p[0] == station and p[1] == 6]
            self.assertEqual([(int.from_bytes(p[2:4], 'big'), int.from_bytes(p[4:6], 'big')) for p in packets],
                             [(0x30, speed & 65535), (0x31, 100), (0x32, 200), (0x4e, 8)])
        session.stop(target='motor1')
        self.wait(lambda: session.snapshot()['axes']['motor1']['driverStopped'])
        status = session.snapshot()
        self.assertEqual(status['axes']['motor1']['state'], 'idle')
        self.assertEqual(status['axes']['motor2']['state'], 'running')
        self.assertFalse(status['axes']['motor1']['physicalStopConfirmed'])
        manager.close()
        self.assertEqual(len(port.owners), 1)

    def test_start_requires_snapshot_and_enabled_fresh_complete_parameters(self):
        for change in ('version', 'disabled', 'stale', 'incomplete', 'duplicate'):
            with self.subTest(change=change):
                session = self.detached()
                if change == 'disabled':
                    session.update_reading('motor1', dict(raw=0, **motor_status(0)))
                elif change == 'stale':
                    session.speed_received['motor1'] -= 2
                elif change == 'incomplete':
                    session.config['operation']['motor1']['speedRpm'] = None
                elif change == 'duplicate':
                    self.start(session)
                status = session.snapshot()
                with self.assertRaises(ValueError):
                    session.start('motor1', status['sessionId'], 'old' if change == 'version' else status['configVersion'])

    def test_stop_at_each_setup_write_prevents_trigger(self):
        for address in (0x30, 0x31, 0x32):
            with self.subTest(address=address):
                session, port, manager = self.connect()
                stopped = threading.Event()
                def hook(packet):
                    if packet[1] == 6 and int.from_bytes(packet[2:4], 'big') == address:
                        session.stop(target='motor1')
                        stopped.set()
                port.hook = hook
                self.start(session)
                self.assertTrue(stopped.wait(1))
                self.wait(lambda: session.snapshot()['axes']['motor1']['driverStopped'])
                self.assertFalse(any(p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08' for p in port.writes))
                self.assertFalse(session.jobs)
                manager.close()

    def test_stop_cancels_both_queued_starts_atomically(self):
        session = self.detached()
        self.start(session)
        self.start(session, 'motor2')
        session.stop(target='motor1')
        self.assertFalse(session.jobs)
        self.assertEqual(set(session.pending), {'motor1'})
        with self.assertRaises(ValueError):
            self.start(session, 'motor2')
        self.assertEqual(session.status['axes']['motor2']['state'], 'idle')

    def test_runtime_guard_works_without_frontend_status_poll(self):
        session, port, manager = self.connect()
        self.start(session)
        self.wait(lambda: session.snapshot()['axes']['motor1']['state'] == 'running')
        with session.lock:
            session.run_deadlines['motor1'] = time.monotonic() - 1
        self.wait(lambda: port.speeds[1] == 0)
        self.wait(lambda: session.snapshot()['axes']['motor1']['driverStopped'])
        self.assertEqual(sum(p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08' for p in port.writes), 1)

    def test_independent_feedback_staleness_and_direction_trip(self):
        for condition in ('status', 'speed', 'direction', 'overspeed', 'disabled'):
            with self.subTest(condition=condition):
                session = self.detached()
                if condition in ('status', 'speed'):
                    received = session.last_received if condition == 'status' else session.speed_received
                    received['motor1'] -= 2
                    session.guard_check()
                else:
                    self.start(session)
                    if condition == 'disabled':
                        session.update_reading('motor1', dict(raw=0, **motor_status(0)))
                    else:
                        session.update_speed('motor1', 65535 if condition == 'direction' else 201)
                self.assertTrue(session.status['faultLatched'])
                self.assertTrue(session.closing)
                self.assertEqual(set(session.pending), {'motor1', 'motor2'})
                self.assertFalse(session.jobs)

    def test_setup_and_trigger_short_write_never_retry_start(self):
        for address in (0x30, 0x31, 0x32, 0x4e):
            with self.subTest(address=address):
                session, port, manager = self.connect()
                original = port.write
                def short_write(packet):
                    count = original(packet)
                    if packet[1] == 6 and int.from_bytes(packet[2:4], 'big') == address and packet[4:6] != b'\x00\x40':
                        return count - 1
                    return count
                port.write = short_write
                self.start(session)
                self.wait(lambda: not manager.active())
                triggers = [p for p in port.writes if p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08']
                self.assertEqual(len(triggers), 1 if address == 0x4e else 0)
                self.assertTrue(any(p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x40' for p in port.writes))
                self.assertEqual(session.snapshot()['axes']['motor1']['state'], 'unknown')
                self.assertTrue(port.closed)

    def test_missing_setup_or_trigger_ack_stops_without_retry(self):
        for address in (0x31, 0x4e):
            with self.subTest(address=address):
                session, port, manager = self.connect()
                def hook(packet):
                    if packet[1] == 6 and int.from_bytes(packet[2:4], 'big') == address and packet[4:6] != b'\x00\x40':
                        port.buffer.clear()
                port.hook = hook
                self.start(session)
                self.wait(lambda: not manager.active())
                triggers = [p for p in port.writes if p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08']
                self.assertEqual(len(triggers), 1 if address == 0x4e else 0)
                self.assertTrue(session.snapshot()['faultLatched'])
                self.assertEqual(port.speeds[1], 0)

    def test_stop_during_pretrigger_refresh_and_trigger_ack(self):
        for stage in ('refresh', 'trigger'):
            with self.subTest(stage=stage):
                session, port, manager = self.connect()
                stopped = threading.Event()
                def hook(packet):
                    refreshed = (stage == 'refresh' and packet[1] == 3 and packet[0] == 1
                                 and packet[2:4] == b'\x00\x0a' and (1, 0x32) in port.parameters)
                    triggered = stage == 'trigger' and packet[1] == 6 and packet[2:6] == b'\x00\x4e\x00\x08'
                    if not stopped.is_set() and (refreshed or triggered):
                        session.stop(target='motor1')
                        stopped.set()
                port.hook = hook
                self.start(session)
                self.assertTrue(stopped.wait(1))
                self.wait(lambda: session.snapshot()['axes']['motor1']['driverStopped'])
                triggers = [p for p in port.writes if p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08']
                self.assertEqual(len(triggers), int(stage == 'trigger'))
                self.assertEqual(session.snapshot()['axes']['motor1']['state'], 'idle')
                manager.close()

    def test_start_and_stop_confirmation_deadlines_fail_closed(self):
        session = self.detached()
        self.start(session)
        session.start_dispatched['motor1'] = time.monotonic() - 4
        session.guard_check()
        self.assertTrue(session.closing)
        self.assertTrue(session.status['faultLatched'])
        session = self.detached()
        session.stop(target='motor1')
        session.take_stop()
        session.stop_dispatched['motor1'] = time.monotonic() - 4
        session.guard_check()
        self.assertEqual(session.status['axes']['motor1']['state'], 'unknown')
        self.assertTrue(session.status['faultLatched'])
        self.assertEqual(set(session.pending), {'motor2'})
        self.assertTrue(session.closing)
        session.guard_check()
        self.assertEqual(set(session.pending), {'motor2'})

    def test_unknown_target_stop_stops_other_axis_without_retrying_failed_target(self):
        session, port, manager = self.connect()
        for target in session.targets:
            self.start(session, target)
            self.wait(lambda: session.snapshot()['axes'][target]['state'] == 'running')
        def missing_ack(packet):
            if packet[0] == 1 and packet[1] == 6 and packet[2:6] == b'\x00\x4e\x00\x20':
                port.buffer.clear()
        port.hook = missing_ack
        session.stop(target='motor1')
        self.wait(lambda: not manager.active())
        stops = [(p[0], int.from_bytes(p[4:6], 'big')) for p in port.writes
                 if p[1] == 6 and p[2:4] == b'\x00\x4e' and p[4:6] != b'\x00\x08']
        self.assertEqual(stops, [(1, 0x20), (2, 0x40)])
        self.assertEqual(port.speeds, {1: 0, 2: 0})
        self.assertTrue(port.closed)
        self.assertEqual(session.snapshot()['axes']['motor1']['state'], 'unknown')

    def test_both_unconfirmed_stops_close_without_repeating_either(self):
        session = self.detached()
        session.stop()
        while session.take_stop():
            pass
        for target in session.targets:
            session.stop_dispatched[target] = time.monotonic() - 4
        session.guard_check()
        self.assertTrue(session.closing)
        self.assertFalse(session.pending)
        self.assertTrue(all(axis['state'] == 'unknown' for axis in session.status['axes'].values()))

    def test_blocked_open_stop_never_starts_or_reopens(self):
        port = JogPort()
        entered, release = threading.Event(), threading.Event()
        calls = []
        def factory(config):
            calls.append(config['port'])
            entered.set()
            if not release.wait(2):
                raise OSError('fake open gate timeout')
            return port
        manager = MotionManager(factory)
        self.addCleanup(manager.close)
        self.addCleanup(release.set)
        session = manager.connect('motors', settings(), control=True)
        self.assertTrue(entered.wait(1))
        session.stop(emergency=True, close=True)
        self.assertTrue(manager.active())
        with self.assertRaises(ValueError):
            manager.connect('motors', settings(), control=True)
        release.set()
        self.wait(lambda: not manager.active())
        self.assertEqual(calls, ['FAKE-JOG'])
        self.assertTrue(port.closed)
        self.assertEqual([(p[0], int.from_bytes(p[4:6], 'big')) for p in port.writes], [(1, 0x40), (2, 0x40)])

    def test_blocked_close_keeps_owner_and_marks_feedback_stale(self):
        session, port, manager = self.connect()
        self.start(session)
        self.wait(lambda: session.snapshot()['axes']['motor1']['state'] == 'running')
        entered, release = threading.Event(), threading.Event()
        original = port.close
        def close():
            entered.set()
            release.wait(2)
            original()
        port.close = close
        self.addCleanup(release.set)
        session.stop(close=True)
        self.assertTrue(entered.wait(1))
        self.assertTrue(manager.active())
        value = session.snapshot()
        self.assertEqual(value['state'], 'disconnecting')
        self.assertEqual(value['readings']['motor1']['quality'], 'stale')
        self.assertEqual(value['readings']['motor1']['speed']['quality'], 'stale')
        with self.assertRaises(ValueError):
            manager.connect('motors', settings(), control=True)
        release.set()
        self.wait(lambda: not manager.active())
        self.assertEqual(session.snapshot()['axes']['motor1']['state'], 'unknown')

    def test_audit_overflow_during_control_stops_once_and_closes(self):
        session, port, manager = self.connect()
        self.start(session)
        self.wait(lambda: session.snapshot()['axes']['motor1']['state'] == 'running')
        with session.lock:
            for _ in range(140):
                session.note_locked('fake audit overflow')
        self.wait(lambda: not manager.active())
        status = session.snapshot()
        self.assertEqual(status['state'], 'failed')
        self.assertGreater(status['auditDropped'], 0)
        self.assertTrue(port.closed)
        self.assertEqual(port.speeds[1], 0)
        self.assertEqual(sum(p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x08' for p in port.writes), 1)
        self.assertEqual(sum(p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x40' for p in port.writes), 2)

    def test_read_failure_during_motion_attempts_stop_without_reconnect(self):
        session, port, manager = self.connect()
        self.start(session)
        self.wait(lambda: session.snapshot()['axes']['motor1']['state'] == 'running')
        original = port.write
        def failed_read(packet):
            if packet[1] == 3:
                raise OSError('fake read transport failure')
            return original(packet)
        port.write = failed_read
        self.wait(lambda: not manager.active())
        stops = [p for p in port.writes if p[1] == 6 and p[2:6] == b'\x00\x4e\x00\x40']
        self.assertEqual([p[0] for p in stops], [1, 2])
        self.assertEqual(port.speeds[1], 0)
        self.assertTrue(port.closed)
        self.assertEqual(session.snapshot()['state'], 'failed')
        self.assertFalse(session.snapshot()['axes']['motor1']['physicalStopConfirmed'])

    def test_stop_ack_alone_does_not_confirm_driver_stopped(self):
        from types import SimpleNamespace
        session = self.detached()
        session.stop(target='motor1')
        target, command = session.take_stop()
        session.send_stop(JogPort(), SimpleNamespace(quiet=0, timeout=.05), target, command)
        axis = session.snapshot()['axes']['motor1']
        self.assertEqual(axis['state'], 'stopping')
        self.assertFalse(axis['driverStopped'])
        self.assertFalse(axis['physicalStopConfirmed'])
        session.update_reading('motor1', dict(raw=16, **motor_status(16)))
        session.update_speed('motor1', 0)
        self.assertTrue(session.snapshot()['axes']['motor1']['driverStopped'])


class MotorRpcTests(unittest.TestCase):
    wait = MotorSessionTests.wait

    def controller(self, directory):
        controller = Controller(Path(directory), lambda *args: None)
        self.addCleanup(controller.close)
        value = defaults()
        value['motors'] = settings()
        controller.request('hardware.save', {'config': value})
        port = JogPort()
        controller.motion.factory = lambda config: port
        return controller, port, value

    def test_rpc_lifecycle_versions_strict_parameters_and_simulation_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, port, value = self.controller(directory)
            self.assertIsNone(controller.request('hardware.motor.status', {}))
            status = controller.request('hardware.motor.connect', {})
            self.wait(lambda: controller.request('hardware.motor.status', {})['axes']['motor1']['canStart'])
            start = dict(target='motor1', sessionId=status['sessionId'], configVersion=status['configVersion'])
            for method, params in (
                ('hardware.motor.connect', {'port': 'OTHER'}),
                ('hardware.motor.start', dict(start, speedRpm=123)),
                ('hardware.motor.start', dict(start, target=[])),
                ('hardware.motor.start', dict(start, configVersion='old')),
                ('hardware.motor.stop', dict(target='motor1', emergency=True)),
                ('hardware.motor.stop', dict(target=None, emergency=1)),
                ('hardware.motor.disconnect', {'target': 'motor1'}),
                ('device.command', {'type': 'toggle', 'device': 'motor1'}),
                ('device.command', {'type': 'initialize'}),
                ('device.command', {'type': 'run'})):
                with self.subTest(method=method, params=params), self.assertRaises(ValueError):
                    controller.request(method, params)
            controller.request('hardware.save', {'config': value})
            self.assertFalse(controller.pending_connections)
            controller.request('hardware.motor.start', start)
            self.wait(lambda: controller.request('hardware.motor.status', {})['axes']['motor1']['state'] == 'running')
            controller.request('hardware.motor.stop', dict(target='motor1', emergency=False))
            self.wait(lambda: controller.request('hardware.motor.status', {})['axes']['motor1']['driverStopped'])
            controller.request('hardware.motor.disconnect', {})
            self.wait(lambda: not controller.motion.active())
            self.assertFalse(any(controller.state['devices'].values()))
            self.assertEqual(controller.records.list(controller.state['database']), [])
            self.assertTrue(port.closed)

    def test_lock_cancels_pending_start_and_closes_control_session(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, port, _ = self.controller(directory)
            status = controller.request('hardware.motor.connect', {})
            self.wait(lambda: controller.request('hardware.motor.status', {})['axes']['motor1']['canStart'])
            controller.request('hardware.motor.start', dict(target='motor1', sessionId=status['sessionId'], configVersion=status['configVersion']))
            controller.request('system.motion.lock', {})
            self.wait(lambda: not controller.motion.active())
            result = controller.request('hardware.motor.status', {})
            self.assertTrue(result['faultLatched'])
            self.assertEqual(port.speeds[1], 0)
            self.assertFalse(controller.motion.sessions['motors'].jobs)
            self.assertTrue(port.closed)

    def test_simulation_commands_are_removed_and_real_inputs_default_to_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            controller, port, _ = self.controller(directory)
            self.assertNotIn('motorMode', controller.state)
            self.assertEqual(set(controller.state['values'].values()), {0})
            with self.assertRaises(ValueError):
                controller.request('hardware.motor.mode', {'mode': 'real'})
            for command in ({'type': 'initialize'}, {'type': 'home'}, {'type': 'zero'}, {'type': 'run'},
                            {'type': 'toggle', 'device': 'lift'}, {'type': 'toggle', 'device': 'motor1'},
                            {'type': 'pressure', 'value': .2}):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    controller.request('device.command', command)
            with self.assertRaises(ValueError):
                controller.request('pressure.zero.start', {})
            for _ in range(3):
                controller.tick()
            self.assertFalse(controller.state['running'])
            self.assertEqual(controller.records.list(controller.state['database']), [])
            self.assertFalse(port.writes)
            controller.request('hardware.motor.connect', {})
            self.assertNotIn('motorMode', controller.state)
            controller.request('device.command', {'type': 'stop'})
            self.wait(lambda: not controller.motion.active())
            with patch.object(MotionManager, 'connect', return_value=SimpleNamespace(status={'sessionId': 'startup'})) as connect:
                restarted = Controller(Path(directory), lambda *args: None)
                connect.assert_called_once_with('motors', restarted.hardware.value['motors'], control=True)
            try:
                self.assertNotIn('motorMode', restarted.state)
                self.assertFalse(restarted.motion.sessions)
                self.assertFalse(any(restarted.state['devices'].values()))
            finally:
                restarted.close()

    def test_priority_barrier_invalidates_older_motor_connect_and_start(self):
        from lab_controller.ipc import server
        for stop in ('hardware.motor.stop', 'hardware.motor.disconnect', 'system.motion.lock', 'system.suspend', 'device.command'):
            with self.subTest(stop=stop):
                inbox = queue.PriorityQueue()
                inbox.put((2, 0, dict(id='connect', method='hardware.motor.connect', params={})))
                inbox.put((2, 1, dict(id='start', method='hardware.motor.start', params={})))
                inbox.put((2, 2, dict(id='operator-start', method='device.command', params={'type': 'motor', 'enabled': True})))
                inbox.put((2, 3, dict(id='save', method='hardware.save', params={})))
                inbox.put((0, 4, dict(id='stop', method=stop, params={'type': 'motor', 'enabled': False} if stop == 'device.command' else {})))
                inbox.put((3, 5, dict(id='exit', method='system.shutdown', params={})))
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
                self.assertEqual(calls, [stop])
                rejected = [response for response in responses if response['id'] in ('connect', 'start', 'operator-start', 'save')]
                self.assertEqual(len(rejected), 4)
                self.assertTrue(all(not response['ok'] and '作废' in response['error']['message'] for response in rejected))

    def test_input_priority_and_barrier_classification_share_one_policy(self):
        from lab_controller.ipc.server import request_priority, stops_motion
        for method in ('hardware.motor.stop', 'hardware.motor.disconnect', 'system.motion.lock', 'system.suspend'):
            self.assertEqual(request_priority(method, {}), 0)
            self.assertTrue(stops_motion(method, {}))
        for method in ('hardware.motor.start', 'hardware.motor.connect', 'hardware.motor.status'):
            self.assertEqual(request_priority(method, {}), 2)
            self.assertFalse(stops_motion(method, {}))
        self.assertEqual(request_priority('system.ping', {}), 1)
        self.assertEqual(request_priority('device.command', {'type': 'emergency'}), 0)
        self.assertEqual(request_priority('device.command', {'type': 'motor', 'enabled': False}), 0)
        self.assertEqual(request_priority('device.command', {'type': 'motor', 'enabled': True}), 2)


if __name__ == '__main__':
    unittest.main()
