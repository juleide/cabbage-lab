"""Fixed machine readiness cannot be inferred from a Python process or open port."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.devices.readiness import assess, REQUIRED


class ReadinessTests(unittest.TestCase):
    def motor(self, **changes):
        reading = dict(quality='valid', running=False, enabled=True, speed=dict(quality='valid', rpm=0))
        reading.update(changes)
        return dict(state='monitoring', readings=dict(motor1=reading, motor2=reading))

    def test_missing_drivers_remain_required(self):
        result = assess({}, {})
        self.assertEqual(result['state'], 'unavailable')
        self.assertEqual(tuple(result['devices']), REQUIRED)
        self.assertIn('arrayPress', result['missing'])
        self.assertIn('lift', result['missing'])

    def test_port_open_without_feedback_is_not_ready(self):
        result = assess({'motors': dict(state='monitoring', readings={})}, {})
        self.assertEqual(result['devices']['motors']['state'], 'unavailable')

    def test_fresh_motor_standby_does_not_make_entire_machine_ready(self):
        result = assess({'motors': self.motor()}, {})
        self.assertEqual(result['devices']['motors']['state'], 'ready')
        self.assertNotEqual(result['state'], 'ready')

    def test_fault_and_stale_feedback_are_not_ready(self):
        for changes in (dict(fault=True), dict(quality='stale'), dict(speed=dict(quality='stale', rpm=0))):
            with self.subTest(changes=changes):
                result = assess({'motors': self.motor(**changes)}, {})
                self.assertEqual(result['state'], 'fault')

    def test_disabled_running_and_limits_are_not_standby(self):
        for changes in (dict(enabled=False), dict(running=True), dict(positiveLimit=True),
                        dict(negativeLimit=True), dict(speed=dict(quality='valid', rpm=10))):
            with self.subTest(changes=changes):
                result = assess({'motors': self.motor(**changes)}, {})
                self.assertNotEqual(result['devices']['motors']['state'], 'ready')

    def test_valid_sensor_zero_is_feedback_but_stale_value_is_not(self):
        result = assess({}, {'tension': dict(state='collecting', quality='valid', reading=dict(value=0))})
        self.assertEqual(result['devices']['tension']['state'], 'ready')
        result = assess({}, {'tension': dict(state='collecting', quality='stale', reading=None)})
        self.assertEqual(result['state'], 'fault')

    def test_connection_and_config_error_priority(self):
        self.assertEqual(assess({'motors': dict(state='connecting')}, {})['state'], 'connecting')
        result = assess({'motors': dict(state='connecting')}, {}, config_error='broken file')
        self.assertEqual(result['state'], 'fault')
        self.assertEqual(result['configError'], 'broken file')

    def test_lift_position_is_not_a_stopped_confirmation(self):
        result = assess({'lift': dict(state='monitoring', readings=dict(lift=dict(positionMm=1)))}, {})
        self.assertEqual(result['devices']['lift']['state'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
