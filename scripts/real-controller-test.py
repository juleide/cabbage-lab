"""Pure hardware controller contracts; no OS serial transport is opened."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.core.controller import Controller
from lab_controller.devices.readings import RealReadings


class RealControllerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        with patch.object(Controller, 'auto_connect_configured'):
            self.controller = Controller(Path(self.directory.name), lambda *args: None)

    def tearDown(self):
        self.controller.motion.sessions.clear()
        self.controller.sensors.sessions.clear()
        self.controller.close()
        self.directory.cleanup()

    def motor_session(self, running=False, quality='valid', state='monitoring'):
        status = dict(sessionId='test', configVersion='version', purpose='control', state=state,
                      error=None, auditDropped=0, readings={
                          'motor1': dict(running=running, quality=quality),
                          'motor2': dict(running=False, quality=quality)})
        session = SimpleNamespace(status=status, snapshot=lambda: copy.deepcopy(status),
                                  collect=lambda: [], thread=SimpleNamespace(is_alive=lambda: True),
                                  start=Mock(), stop=Mock())
        self.controller.motion.sessions['motors'] = session
        return session

    def test_initial_eight_metrics_are_zero_with_unavailable_quality(self):
        state = self.controller.snapshot()['state']
        self.assertEqual(set(state['values']), {'normal', 'friction', 'area', 'speed',
                                               'coefficient', 'pressure', 'gripArea', 'gripForce'})
        self.assertEqual(set(state['values'].values()), {0})
        self.assertFalse(any(item['valid'] for item in state['measurementQuality'].values()))
        self.assertTrue(all(item['state'] == 'unknown' for item in state['deviceFeedback'].values()))
        self.assertNotIn('motorMode', state)
        self.assertIsNone(self.controller.array.snapshot())

    def test_non_motion_library_selection_is_available_during_software_stop(self):
        self.controller.command({'type': 'emergency'})
        self.controller.command({'type': 'database', 'value': 'cabbage_test_archive'})
        self.assertEqual(self.controller.state['database'], 'cabbage_test_archive')
        self.assertTrue(self.controller.state['stopped'])
        self.controller.command({'type': 'reset'})
        self.assertFalse(self.controller.state['stopped'])
        self.assertFalse(self.controller.state['zero'])

    def test_unsupported_commands_have_no_side_effects_or_trial_samples(self):
        before = self.controller.snapshot()['state']
        commands = [{'type': kind} for kind in ('initialize', 'home', 'zero', 'run', 'commitPressure')]
        commands += [dict(type='toggle', device='motor1'), dict(type='pressure', value=.4)]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.controller.command(command)
        for _ in range(3):
            self.controller.tick()
        state = self.controller.snapshot()['state']
        for key in ('devices', 'initialized', 'zero', 'pressure', 'sampleCount', 'values'):
            self.assertEqual(state[key], before[key])
        self.assertEqual(self.controller.records.list(state['database']), [])

    def test_reset_waits_for_motion_close_without_claiming_physical_stop(self):
        self.motor_session(running=True)
        self.controller.command({'type': 'emergency'})
        with self.assertRaises(ValueError):
            self.controller.command({'type': 'reset'})
        state = self.controller.snapshot()['state']
        self.assertTrue(state['stopped'])
        self.assertFalse(state['deviceFeedback']['motor1']['physicalStopConfirmed'])

    def test_only_fresh_feedback_sets_output_and_disconnection_is_unknown(self):
        session = self.motor_session(running=True)
        state = self.controller.snapshot()['state']
        self.assertTrue(state['devices']['motor1'])
        self.assertEqual(state['deviceFeedback']['motor2']['state'], 'stopped')
        session.status['readings']['motor1']['quality'] = 'stale'
        state = self.controller.snapshot()['state']
        self.assertFalse(state['devices']['motor1'])
        self.assertEqual(state['deviceFeedback']['motor1']['state'], 'unknown')
        self.assertEqual(state['deviceFeedback']['motor1']['quality'], 'stale')
        session.status['state'] = 'disconnected'
        self.assertEqual(self.controller.snapshot()['state']['deviceFeedback']['motor2']['state'], 'unknown')

    def test_second_axis_start_does_not_require_first_axis_to_be_idle(self):
        session = self.motor_session(running=True)
        self.controller.request('hardware.motor.start', dict(target='motor2', sessionId='test', configVersion='version'))
        session.start.assert_called_once_with('motor2', 'test', 'version')

    def test_operator_motor_command_is_explicit_and_stop_survives_software_lock(self):
        session = self.motor_session()
        command = dict(type='motor', device='motor2', enabled=True, sessionId='test', configVersion='version')
        self.controller.command(command)
        session.start.assert_called_once_with('motor2', 'test', 'version')
        self.controller.state['stopped'] = True
        with self.assertRaises(ValueError):
            self.controller.command(command)
        self.controller.command({**command, 'enabled': False, 'sessionId': 'old', 'configVersion': 'old'})
        session.stop.assert_called_once_with(target='motor2', emergency=False)

    def test_operator_motor_command_rejects_invalid_target_or_implicit_enable(self):
        session = self.motor_session()
        command = dict(type='motor', device='motor1', enabled=True, sessionId='test', configVersion='version')
        for invalid in ({'device': 'lift'}, {'enabled': 1}, {'enabled': 'false'}, {'sessionId': None}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.controller.command({**command, **invalid})
        session.start.assert_not_called()
        session.stop.assert_not_called()

    def test_raw_sensor_units_do_not_guess_mechanical_roles(self):
        for section, unit in (('tension', 'N'), ('displacement', 'mm')):
            events = [dict(kind='sample', quality='valid', number=1, value=12,
                           absoluteValue=12, unit=unit, receivedAt=100)]
            status = dict(sessionId=section, state='collecting', quality='valid')
            session = SimpleNamespace(collect=lambda events=events, status=status: (events, status),
                                      snapshot=lambda status=status: status)
            self.controller.sensors.sessions[section] = session
        with patch.object(self.controller.records, 'append_sensor') as append:
            self.controller.poll_hardware()
            self.assertEqual(append.call_count, 2)
        self.assertEqual(set(self.controller.snapshot()['state']['values'].values()), {0})

    def test_real_zero_and_expiration_remain_distinguishable_after_emergency(self):
        clock = [0]
        self.controller.readings = RealReadings(clock=lambda: clock[0])
        self.controller.readings.update('gripForce', 0, source='test:force', unit='N')
        state = self.controller.snapshot()['state']
        self.assertTrue(state['measurementQuality']['gripForce']['valid'])
        self.controller.command({'type': 'emergency'})
        clock[0] = 2
        self.controller.tick()
        self.assertFalse(self.controller.state['measurementQuality']['gripForce']['valid'])
        self.assertEqual(self.controller.state['measurementQuality']['gripForce']['state'], 'stale')

    def test_recording_accepts_real_zero_but_ends_before_expired_placeholder(self):
        from lab_controller.devices.readings import UNITS
        clock = [0]
        self.controller.readings = RealReadings(clock=lambda: clock[0])
        for name, unit in UNITS.items():
            self.controller.readings.update(name, 1 if name == 'normal' else 0, source='test:' + name, unit=unit)
        self.controller.records.begin('quality-test', self.controller.state['database'], 'test', {})
        self.controller.state.update(running=True, runId='quality-test', sampleCount=0)
        self.controller.tick()
        self.assertEqual(self.controller.records.count('quality-test'), 1)
        self.assertEqual(self.controller.records.read('quality-test', 0, 10)[0]['friction'], 0)
        clock[0] = 2
        self.controller.tick()
        self.assertEqual(self.controller.records.count('quality-test'), 1)
        self.assertFalse(self.controller.state['running'])
        record = self.controller.records.list(self.controller.state['database'])[0]
        self.assertEqual(record['status'], 'stopped')
        self.assertIsNotNone(record['endedAt'])
        self.assertTrue(any('必要真实读数失效' in log['message'] for log in self.controller.records.logs()))


if __name__ == '__main__':
    unittest.main()
