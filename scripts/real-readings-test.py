"""Real input/zero placeholder distinction, no serial ports opened."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.devices.readings import RealReadings


class RealReadingsTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.readings = RealReadings(clock=lambda: self.now)

    def test_replayed_sample_timestamp_does_not_refresh_validity(self):
        self.readings.update('normal', 12, source='force:1', unit='N', received=0)
        self.now = 2
        self.readings.update('normal', 12, source='force:1', unit='N', received=0)
        self.assertFalse(self.readings.snapshot()['quality']['normal']['valid'])
        self.readings.update('normal', 8, source='force:1', unit='N', received=2)
        self.readings.update('normal', 20, source='force:1', unit='N', received=1)
        self.assertEqual(self.readings.snapshot()['values']['normal'], 8)

    def test_invalid_or_future_timestamps_invalidate_old_value(self):
        for received in (float('nan'), float('inf'), True, '0', 1):
            self.readings.update('normal', 12, source='force:1', unit='N')
            with self.assertRaises(ValueError):
                self.readings.update('normal', 12, source='force:1', unit='N', received=received)
            self.assertFalse(self.readings.snapshot()['quality']['normal']['valid'])

    def test_initial_values_are_zero_and_unavailable(self):
        value = self.readings.snapshot()
        self.assertTrue(all(number == 0 for number in value['values'].values()))
        self.assertTrue(all(not item['valid'] for item in value['quality'].values()))

    def test_real_zero_is_valid_and_unrelated_missing_inputs_do_not_hide_reading(self):
        self.readings.update('friction', 0, source='tension:1', unit='N')
        value = self.readings.snapshot()
        self.assertEqual(value['values']['friction'], 0)
        self.assertTrue(value['quality']['friction']['valid'])
        self.assertFalse(value['quality']['normal']['valid'])

    def test_expired_and_disconnected_values_zero_without_last_value_fallback(self):
        self.readings.update('normal', 12, source='force:1', unit='N')
        self.now = 1.001
        value = self.readings.snapshot()
        self.assertEqual(value['values']['normal'], 0)
        self.assertEqual(value['quality']['normal']['state'], 'stale')
        self.readings.update('normal', 8, source='force:1', unit='N')
        self.readings.invalidate_source('force:1')
        self.assertEqual(self.readings.snapshot()['values']['normal'], 0)

    def test_invalid_input_removes_old_value_and_wrong_units_are_not_engineering_values(self):
        for value, unit in ((True, 'N'), (float('nan'), 'N'), (float('inf'), 'N'), ('12', 'N'), (12, 'raw')):
            self.readings.update('normal', 12, source='force:1', unit='N')
            with self.assertRaises(ValueError):
                self.readings.update('normal', value, source='force:1', unit=unit)
            self.assertFalse(self.readings.snapshot()['quality']['normal']['valid'])
        with self.assertRaises(ValueError):
            self.readings.update('coefficient', .5, source='external', unit='1')

    def test_coefficient_requires_two_fresh_real_forces_and_positive_normal(self):
        self.readings.update('normal', 10, source='force:1', unit='N')
        self.readings.update('friction', 2, source='tension:1', unit='N')
        self.assertEqual(self.readings.snapshot()['values']['coefficient'], .2)
        self.now = 1.001
        self.readings.update('friction', 2, source='tension:1', unit='N')
        self.assertFalse(self.readings.snapshot()['quality']['coefficient']['valid'])
        self.readings.update('normal', 0, source='force:1', unit='N')
        self.assertEqual(self.readings.snapshot()['values']['coefficient'], 0)


if __name__ == '__main__':
    unittest.main()
