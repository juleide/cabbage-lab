"""Hardware configuration tests; no physical device is accessed."""
import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend' / 'src'))
from lab_controller.storage.hardware import HardwareStore, defaults, validate


class HardwareTests(unittest.TestCase):
    def test_draft_and_complete(self):
        value = defaults()
        self.assertEqual(validate(value), [])
        self.assertTrue(validate(value, True))
        self.assertEqual(validate(value, True, 'array'), [])
        value['array']['grip']['rev'] = 0
        self.assertTrue(validate(value))

    def test_ranges_ports_and_inactive_mode(self):
        value = defaults()
        value['motors'].update(motor1=1, motor2=1)
        self.assertTrue(any('站号' in e for e in validate(value)))
        value['motors']['motor2'] = 2
        value['motors']['serial'].update(port='com3', baud=9600)
        value['array']['grip']['serial'].update(port='COM3', baud=115200)
        self.assertEqual(validate(value), [])  # inactive serial binding does not reserve ports
        value['array']['mode'] = 'serial'
        self.assertTrue(any('已用于' in e for e in validate(value)))
        self.assertTrue(any('已用于' in e for e in validate(value, True, 'motors')))
        value['array']['mode'] = 'usb'
        value['displacement'].update(model='p', lower=100, upper=50)
        self.assertTrue(any('上限' in e for e in validate(value)))
        value['displacement'].update(reading='float')
        self.assertEqual(validate(value), [])
        for bad in [None, True, '1000', 0, float('nan')]:
            changed = copy.deepcopy(value)
            changed['motors']['serial']['timeoutMs'] = bad
            self.assertTrue(validate(changed))

    def test_controller_methods_and_simulation_unchanged(self):
        from lab_controller.core.controller import Controller
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            controller = Controller(root, lambda *args: None)
            try:
                before = copy.deepcopy(controller.config.value)
                snapshot = controller.request('hardware.get', {})
                with patch('lab_controller.core.controller.list_ports', return_value={'ports': []}) as scan:
                    self.assertEqual(controller.request('hardware.ports.list', {}), {'ports': []})
                    scan.assert_called_once_with()
                with self.assertRaises(ValueError):
                    controller.request('hardware.ports.list', {'port': 'COM3'})
                self.assertFalse(snapshot['drivers']['available'])
                value = snapshot['config']
                value['array']['press']['rev'] = 3
                controller.request('hardware.save', {'config': value})
                self.assertEqual(controller.config.value, before)
                self.assertFalse(any(controller.device.outputs.values()))
                self.assertEqual(controller.request('hardware.check', {'config': value, 'section': 'array'}), {'errors': []})
                controller.device.set_output('motor1', True)
                with self.assertRaisesRegex(ValueError, '停止'):
                    controller.request('hardware.save', {'config': value})
            finally:
                controller.close()
            restarted = Controller(root, lambda *args: None)
            try:
                self.assertEqual(restarted.request('hardware.get', {})['config']['array']['press']['rev'], 3)
            finally:
                restarted.close()

    def test_store_round_trip_and_corruption_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config' / 'hardware.json'
            store = HardwareStore(path)
            value = defaults()
            value['array']['press']['rev'] = 2
            store.save(value)
            self.assertEqual(HardwareStore(path).value, value)
            value['array']['press']['rev'] = 3
            self.assertEqual(store.value['array']['press']['rev'], 2)
            path.write_text('{broken', encoding='utf-8')
            broken = HardwareStore(path)
            self.assertIsNotNone(broken.error)
            with self.assertRaises(ValueError):
                broken.save(defaults())
            self.assertEqual(path.read_text(), '{broken')
            path.write_text(json.dumps({'schemaVersion': 99}))
            self.assertIsNotNone(HardwareStore(path).error)


if __name__ == '__main__':
    unittest.main()
