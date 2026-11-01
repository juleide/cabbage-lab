"""Controller-level port ownership and unified session startup, without hardware."""
import sys
import json
import copy
import runpy
import time
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend' / 'src'))
from lab_controller.core.controller import Controller
from lab_controller.devices.sensors import port_key


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        with patch.object(Controller, 'auto_connect_configured'):
            self.controller = Controller(Path(self.directory.name), lambda *args: None)
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.controller.motion.sessions.clear()
        self.controller.sensors.sessions.clear()
        self.controller.close()

    def session(self, port, alive=True):
        return SimpleNamespace(config={'serial': {'port': port}},
                               thread=SimpleNamespace(is_alive=lambda: alive))

    def test_port_aliases_and_cross_manager_ownership(self):
        for occupied, requested in [('COM3', 'com3'), ('/dev/cu.usb-test', '/dev/tty.usb-test')]:
            for owner, target in ((self.controller.sensors, 'motors'), (self.controller.motion, 'tension')):
                owner.sessions['owner'] = self.session(occupied)
                with self.subTest(occupied=occupied, target=target), self.assertRaises(ValueError):
                    self.controller.require_port_available(target, {'serial': {'port': requested}})
                owner.sessions.clear()
        self.assertEqual(port_key(' COM3 '), port_key('com3'))

    def test_live_thread_reserves_port_even_while_disconnecting(self):
        self.controller.sensors.sessions['tension'] = self.session('COM3')
        with self.assertRaises(ValueError):
            self.controller.require_port_available('tension', {'serial': {'port': 'COM4'}})
        self.controller.sensors.sessions['tension'] = self.session('COM3', alive=False)
        self.controller.require_port_available('tension', {'serial': {'port': 'COM3'}})

    def test_independent_ports_are_not_globally_mutually_exclusive(self):
        self.controller.motion.sessions['motors'] = self.session('COM3')
        self.controller.sensors.sessions['tension'] = self.session('COM4')
        self.controller.require_port_available('displacement', {'serial': {'port': 'COM5'}})

    def test_verification_reservation_survives_cancellation_until_thread_exit(self):
        with patch.object(self.controller.verification, 'active', return_value=True), patch.object(
                self.controller.verification, 'snapshot', return_value={'section': 'tension', 'port': 'COM3'}):
            with self.assertRaises(ValueError):
                self.controller.require_port_available('motors', {'serial': {'port': 'com3'}})
            self.controller.require_port_available('motors', {'serial': {'port': 'COM4'}})

    def test_auto_connect_attempts_all_supported_sections_after_independent_failures(self):
        with patch.object(self.controller, 'connect_sensor', side_effect=ValueError('not connected')) as sensors, patch.object(
                self.controller, 'connect_motion', side_effect=ValueError('not connected')) as motion:
            self.controller.auto_connect_configured()
            self.assertEqual([call.args[0] for call in sensors.call_args_list], ['tension', 'displacement'])
            self.assertEqual([call.args[0] for call in motion.call_args_list], ['motors', 'lift'])
            self.assertEqual(motion.call_args_list[0].kwargs, {'control': True})
            self.assertEqual(motion.call_args_list[1].kwargs, {'control': False})

    def test_restart_preserves_invalid_motor_settings_but_connects_valid_tension(self):
        from lab_controller.storage.hardware import HardwareStore
        value = self.controller.hardware.value
        value['motors']['motor1'] = 255
        value['tension']['serial']['port'] = 'TEST-TENSION'
        path = self.controller.hardware.path
        raw = json.dumps(value)
        path.write_text(raw)
        self.controller.hardware = HardwareStore(path)
        session = SimpleNamespace(snapshot=lambda: {'sessionId': 'isolated'},
                                  thread=SimpleNamespace(start=Mock()))
        with patch.object(self.controller.sensors, 'connect', return_value=session) as connect, patch.object(
                self.controller.records, 'begin_sensor'):
            self.controller.auto_connect_configured()
        connect.assert_called_once_with('tension', value['tension'])
        session.thread.start.assert_called_once()
        self.assertIn('motors', self.controller.connection_errors)
        self.assertNotIn('tension', self.controller.connection_errors)
        self.assertEqual(path.read_text(), raw)

    def test_invalid_run_parameters_do_not_prevent_real_read_only_motor_startup(self):
        from lab_controller.storage.hardware import HardwareStore
        fixture = runpy.run_path(str(Path(__file__).parent / 'motor-control-test.py'))
        value = copy.deepcopy(self.controller.hardware.value)
        value['motors'] = fixture['settings']()
        value['motors']['operation']['motor1']['speedRpm'] = 4000
        self.controller.hardware.path.write_text(json.dumps(value))
        self.controller.hardware = HardwareStore(self.controller.hardware.path)
        port = fixture['JogPort']()
        self.controller.motion.factory = lambda settings: port
        try:
            self.controller.auto_connect_configured()
            session = self.controller.motion.sessions['motors']
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                status = session.snapshot()
                if all(status['readings'].get(target, {}).get('speed', {}).get('quality') == 'valid'
                       for target in ('motor1', 'motor2')):
                    break
                time.sleep(.005)
            else:
                self.fail('invalid operation parameters blocked read-only startup')
            self.assertFalse(status['axes']['motor1']['canStart'])
            with self.assertRaises(ValueError):
                session.start('motor1', status['sessionId'], status['configVersion'])
            self.assertTrue(port.writes)
            self.assertTrue(all(packet[1] == 3 for packet in port.writes))
        finally:
            self.controller.motion.close()
            self.controller.poll_hardware()

    def test_sensor_thread_start_failure_closes_record_and_removes_pending_session(self):
        config = self.controller.hardware.value['tension']
        config['serial']['port'] = 'TEST-TENSION'
        session = SimpleNamespace(snapshot=lambda: {'sessionId': 'failed-thread'}, disconnect=Mock(),
                                  thread=SimpleNamespace(start=Mock(side_effect=RuntimeError('thread failure'))))
        def connect(section, config):
            self.controller.sensors.sessions[section] = session
            return session
        with patch.object(self.controller.sensors, 'connect', side_effect=connect), patch.object(
                self.controller.records, 'begin_sensor') as begin, patch.object(
                self.controller.records, 'finish_sensor') as finish:
            with self.assertRaisesRegex(RuntimeError, 'thread failure'):
                self.controller.connect_sensor('tension')
            begin.assert_called_once()
            finish.assert_called_once()
            self.assertEqual(finish.call_args.args[0]['state'], 'failed')
            session.disconnect.assert_called_once()
            self.assertNotIn('tension', self.controller.sensors.sessions)

    def test_metadata_failure_never_starts_io_and_removes_pending_session(self):
        self.controller.hardware.value['tension']['serial']['port'] = 'TEST-TENSION'
        session = SimpleNamespace(snapshot=lambda: {}, disconnect=Mock(), thread=SimpleNamespace(start=Mock()))
        def connect(section, config):
            self.controller.sensors.sessions[section] = session
            return session
        with patch.object(self.controller.sensors, 'connect', side_effect=connect), patch.object(
                self.controller.records, 'begin_sensor', side_effect=OSError('database failed')):
            with self.assertRaises(OSError):
                self.controller.connect_sensor('tension')
        session.thread.start.assert_not_called()
        self.assertNotIn('tension', self.controller.sensors.sessions)

    def test_manual_and_automatic_paths_share_connection_helpers(self):
        with patch.object(self.controller, 'connect_sensor') as sensor, patch.object(
                self.controller, 'connect_motion', return_value=SimpleNamespace(snapshot=lambda: {})) as motion:
            self.controller.request('hardware.sensors.connect', {'section': 'tension'})
            sensor.assert_called_once_with('tension')
            self.controller.request('hardware.motor.connect', {})
            motion.assert_called_once_with('motors', control=True)
            self.controller.request('hardware.motion.connect', {'section': 'lift'})
            self.assertEqual(motion.call_args.args, ('lift',))

    def test_changed_active_config_waits_for_release_and_reconnects_once(self):
        alive = [True]
        old = SimpleNamespace(thread=SimpleNamespace(is_alive=lambda: alive[0]), status={'purpose': 'control'}, stop=Mock())
        self.controller.motion.sessions['motors'] = old
        value = copy.deepcopy(self.controller.hardware.value)
        value['motors']['serial'].update(port='CHANGED-MOTOR', baud=9600)
        with patch.object(self.controller, 'poll_hardware'), patch.object(self.controller, 'refresh'):
            self.controller.request('hardware.save', {'config': value})
        old.stop.assert_called_once_with(emergency=False, close=True)
        with patch.object(self.controller, 'connect_motion') as connect:
            self.controller.apply_pending_connections()
            connect.assert_not_called()
            alive[0] = False
            self.controller.apply_pending_connections()
            connect.assert_called_once_with('motors', control=True)
            self.controller.apply_pending_connections()
            self.assertEqual(connect.call_count, 1)

    def test_pending_reconnect_timeout_and_lock_never_reopen_port(self):
        old = SimpleNamespace(thread=SimpleNamespace(is_alive=lambda: True), status={'purpose': 'diagnostic'}, stop=Mock())
        self.controller.motion.sessions['motors'] = old
        with patch.object(self.controller, 'poll_hardware'), patch.object(self.controller, 'refresh'), patch.object(
                self.controller, 'connect_motion') as connect:
            for action in ('timeout', 'lock', 'stop'):
                self.controller.pending_connections['motors'] = dict(session=old, deadline=0 if action == 'timeout' else float('inf'), control=True)
                if action == 'lock':
                    self.controller.request('system.motion.lock', {})
                elif action == 'stop':
                    with self.assertRaises(ValueError):
                        self.controller.command(dict(type='motor', device='motor1', enabled=False, sessionId='old', configVersion='old'))
                self.controller.apply_pending_connections()
                self.assertFalse(self.controller.pending_connections)
            connect.assert_not_called()

    def test_failed_save_does_not_close_sessions_or_schedule_reconnect(self):
        old = SimpleNamespace(thread=SimpleNamespace(is_alive=lambda: True), status={'purpose': 'control'}, stop=Mock())
        self.controller.motion.sessions['motors'] = old
        value = copy.deepcopy(self.controller.hardware.value)
        value['motors']['serial']['port'] = 'CHANGED-MOTOR'
        before = self.controller.hardware.path.read_bytes()
        with patch.object(self.controller, 'poll_hardware'), patch.object(self.controller, 'refresh'), patch.object(
                Path, 'replace', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.controller.request('hardware.save', {'config': value})
        old.stop.assert_not_called()
        self.assertFalse(self.controller.pending_connections)
        self.assertEqual(self.controller.hardware.path.read_bytes(), before)

    def test_two_changed_connections_wait_for_both_old_ports_before_reopening(self):
        alive = [False, True]
        old = [SimpleNamespace(thread=SimpleNamespace(is_alive=lambda i=i: alive[i]), status={}) for i in range(2)]
        for i, section in enumerate(('motors', 'lift')):
            self.controller.pending_connections[section] = dict(session=old[i], deadline=float('inf'), control=section == 'motors')
        with patch.object(self.controller, 'connect_motion') as connect:
            self.controller.apply_pending_connections()
            connect.assert_not_called()
            alive[1] = False
            self.controller.apply_pending_connections()
            self.assertEqual({call.args[0] for call in connect.call_args_list}, {'motors', 'lift'})
            self.assertFalse(self.controller.pending_connections)

    def test_failed_close_cancels_reconnect_instead_of_clearing_fault_latch(self):
        for status in ({'state': 'failed'}, {'error': 'stop acknowledgement lost'}, {'faultLatched': True}):
            with self.subTest(status=status), patch.object(self.controller, 'connect_motion') as connect:
                old = SimpleNamespace(thread=SimpleNamespace(is_alive=lambda: False), status=status)
                self.controller.pending_connections['motors'] = dict(session=old, deadline=float('inf'), control=True)
                self.controller.apply_pending_connections()
                self.assertFalse(self.controller.pending_connections)
                self.assertIn('停止结果未知', self.controller.connection_errors['motors'])
                connect.assert_not_called()

    def test_real_workers_coexist_and_startup_only_reads_then_explicitly_reconnects(self):
        fixtures = Path(__file__).parent
        motor = runpy.run_path(str(fixtures / 'motor-control-test.py'))['JogPort']()
        sensor = runpy.run_path(str(fixtures / 'hardware-sensors-test.py'))['Port']([1234, 0])
        config = self.controller.hardware.value
        config['motors']['serial'].update(port='TEST-MOTOR', baud=9600, timeoutMs=50, intervalMs=10)
        config['tension']['serial'].update(port='TEST-TENSION', timeoutMs=50, intervalMs=10)
        self.controller.motion.factory = lambda settings: motor
        self.controller.sensors.factory = lambda settings: sensor
        self.controller.auto_connect_configured()
        def wait_ready():
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                self.controller.poll_hardware()
                if (self.controller.sensors.sessions['tension'].snapshot()['quality'] == 'valid'
                        and len(self.controller.motion.sessions['motors'].snapshot()['readings']) == 2):
                    return
                time.sleep(.005)
            self.fail('independent workers did not both receive feedback')
        try:
            wait_ready()
            self.assertTrue(all(packet[1] == 3 for packet in motor.writes + sensor.writes))
            self.assertFalse(self.controller.sensors.sessions.get('displacement'))
            old = self.controller.sensors.sessions['tension']
            self.controller.request('hardware.sensors.disconnect', {'section': 'tension'})
            old.thread.join(timeout=2)
            self.assertFalse(old.thread.is_alive())
            self.assertTrue(sensor.closed)
            self.controller.sensors.factory = lambda settings: runpy.run_path(
                str(fixtures / 'hardware-sensors-test.py'))['Port']([1234, 0])
            self.controller.request('hardware.sensors.connect', {'section': 'tension'})
            self.assertNotEqual(old.status['sessionId'], self.controller.sensors.sessions['tension'].status['sessionId'])
            wait_ready()
            self.assertTrue(self.controller.motion.active())
            # Saving a sensor-only change must not interrupt the motor bus.
            motor_session = self.controller.motion.sessions['motors']
            sensor_session = self.controller.sensors.sessions['tension']
            changed = copy.deepcopy(self.controller.hardware.value)
            changed['tension']['decimals'] = 2
            self.controller.request('hardware.save', {'config': changed})
            sensor_session.thread.join(timeout=2)
            self.assertFalse(sensor_session.thread.is_alive())
            self.controller.apply_pending_connections()
            wait_ready()
            self.assertIs(self.controller.motion.sessions['motors'], motor_session)
            self.assertIsNot(self.controller.sensors.sessions['tension'], sensor_session)
            self.assertEqual(sensor_session.config['decimals'], 0)
            self.assertEqual(self.controller.sensors.sessions['tension'].config['decimals'], 2)
            self.assertTrue(all(packet[1] == 3 for packet in motor.writes))
        finally:
            self.controller.sensors.close()
            self.controller.motion.close()
            self.controller.poll_hardware()


if __name__ == '__main__':
    unittest.main()
