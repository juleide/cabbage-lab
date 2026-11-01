"""Hardware configuration tests; no physical device is accessed."""
import copy
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend' / 'src'))
from lab_controller.storage.hardware import HardwareStore, defaults, validate, validate_motor_operation, MAX_MOTOR_RUN_MS


class HardwareTests(unittest.TestCase):
    def legacy(self):
        value = defaults()
        value['schemaVersion'] = 1
        del value['motors']['operation']
        return value

    def test_v1_migrates_in_memory_only_without_guessing_runtime_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'hardware.json'
            old = self.legacy()
            old['motors'].update(motor1=1, motor2=2)
            old['motors']['serial'].update(port='OFFLINE', baud=9600)
            raw = json.dumps(old).encode()
            path.write_bytes(raw)
            store = HardwareStore(path)
            self.assertIsNone(store.error)
            self.assertEqual(store.value['schemaVersion'], 2)
            self.assertEqual(path.read_bytes(), raw)
            self.assertTrue(store.warnings)
            for operation in store.value['motors']['operation'].values():
                self.assertTrue(all(value is None for value in operation.values()))
                self.assertTrue(validate_motor_operation(operation, complete=True))
            self.assertEqual(validate(store.value, True, 'motors'), [])
            store.save(store.value)
            self.assertEqual(json.loads(path.read_text())['schemaVersion'], 2)
            self.assertEqual(store.warnings, [])
            self.assertEqual(HardwareStore(path).value, store.value)

    def test_legacy_unsupported_motor_connection_is_preserved_for_correction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'hardware.json'
            old = self.legacy()
            old['motors'].update(motor1=254, motor2=2)
            old['motors']['serial'].update(baud=57600, bits=7, parity='E', stop=2)
            raw = json.dumps(old)
            path.write_text(raw)
            store = HardwareStore(path)
            self.assertIsNone(store.error)
            self.assertEqual(store.value['motors']['motor1'], 254)
            self.assertEqual(store.value['motors']['serial']['baud'], 57600)
            self.assertGreater(len(store.warnings), 1)
            self.assertTrue(validate(store.value, True, 'motors'))
            with self.assertRaises(ValueError):
                store.save(store.value)
            self.assertEqual(path.read_text(), raw)
            store.value['motors'].update(motor1=1)
            store.value['motors']['serial'].update(baud=38400, bits=8, parity='N', stop=1)
            store.save(store.value)
            self.assertIsNone(HardwareStore(path).error)

    def test_legacy_shape_not_bypassed_and_invalid_v2_is_not_migrated(self):
        for change in ('unknown', 'operation', 'boolean-version', 'bad-range', 'bad-v2'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'hardware.json'
                value = self.legacy()
                if change == 'unknown':
                    value['permission'] = True
                elif change == 'operation':
                    value['motors']['operation'] = defaults()['motors']['operation']
                elif change == 'boolean-version':
                    value['schemaVersion'] = True
                elif change == 'bad-range':
                    value['motors']['motor1'] = 255
                else:
                    value = defaults()
                    value['motors']['serial']['baud'] = 57600
                raw = json.dumps(value)
                path.write_text(raw)
                store = HardwareStore(path)
                self.assertIsNotNone(store.error)
                self.assertEqual(path.read_text(), raw)

    def test_motor_operation_strict_draft_complete_ranges_and_independence(self):
        value = defaults()
        self.assertEqual(value['schemaVersion'], 2)
        operation = dict(direction=-1, speedRpm=10, maxSpeedRpm=20,
                         accelerationMs=100, decelerationMs=100, maxRunMs=2000)
        self.assertEqual(validate_motor_operation(operation, complete=True), [])
        value['motors']['operation']['motor1'] = operation
        self.assertIsNone(value['motors']['operation']['motor2']['speedRpm'])
        self.assertEqual(validate(value), [])
        for key in operation:
            for bad in (True, 1.5, '1', float('inf'), float('nan'), 0):
                changed = dict(operation, **{key: bad})
                self.assertTrue(validate_motor_operation(changed), (key, bad))
            self.assertEqual(validate_motor_operation(dict(operation, **{key: None})), [])
            self.assertTrue(validate_motor_operation(dict(operation, **{key: None}), complete=True))
        for key, bad in (('speedRpm', 21), ('maxSpeedRpm', 3001), ('direction', 2),
                         ('accelerationMs', 2001), ('decelerationMs', 2001), ('maxRunMs', MAX_MOTOR_RUN_MS + 1)):
            self.assertTrue(validate_motor_operation(dict(operation, **{key: bad})))
        self.assertTrue(validate_motor_operation(dict(operation, canExecute=True)))
        self.assertEqual(validate_motor_operation(dict(operation, maxRunMs=MAX_MOTOR_RUN_MS)), [])

    def test_motor_protocol_formats_and_other_device_baud_unchanged(self):
        value = defaults()
        value['motors'].update(motor1=1, motor2=247)
        for baud in (9600, 19200, 38400, 115200):
            for parity, stop in (('N', 1), ('N', 2), ('E', 1), ('O', 1)):
                value['motors']['serial'].update(baud=baud, parity=parity, stop=stop)
                self.assertEqual(validate(value), [])
        for patch in (dict(baud=57600), dict(bits=7), dict(parity='E', stop=2)):
            changed = copy.deepcopy(value)
            changed['motors']['serial'].update(patch)
            self.assertTrue(validate(changed))
        value['tension']['serial']['baud'] = 57600
        self.assertEqual(validate(value), [])

    def test_manual_edit_applies_on_restart_and_failed_replace_keeps_loaded_value(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'hardware.json'
            store = HardwareStore(path)
            store.save(defaults())
            changed = copy.deepcopy(store.value)
            changed['motors']['operation']['motor1']['speedRpm'] = 10
            path.write_text(json.dumps(changed))
            self.assertIsNone(store.value['motors']['operation']['motor1']['speedRpm'])
            self.assertEqual(HardwareStore(path).value, changed)
            raw = path.read_bytes()
            with patch.object(Path, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    store.save(defaults())
            self.assertEqual(path.read_bytes(), raw)
            self.assertIsNone(store.value['motors']['operation']['motor1']['speedRpm'])

    def test_v2_migration_invalidates_old_safety_binding_without_rewriting_safety(self):
        from lab_controller.storage.motion_safety import MotionSafetyStore, hardware_version
        from lab_controller.devices.motion_safety import assess
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'hardware.json'
            old = self.legacy()
            path.write_text(json.dumps(old))
            safety_path = Path(directory) / 'motion-safety.json'
            safety = MotionSafetyStore(safety_path)
            profile = copy.deepcopy(safety.value)
            profile['hardwareVersion'] = hardware_version(old)
            safety.save(profile, safety.version)
            raw = safety_path.read_bytes()
            migrated = HardwareStore(path)
            self.assertIsNone(migrated.error)
            self.assertFalse(assess(safety, migrated.value, {})['bindingMatches'])
            self.assertEqual(safety_path.read_bytes(), raw)
            self.assertEqual(safety.value['hardwareVersion'], hardware_version(old))

    def test_example_matches_current_defaults(self):
        path = Path(__file__).resolve().parents[1] / 'docs' / 'examples' / 'hardware.v2.example.json'
        self.assertEqual(json.loads(path.read_text()), defaults())

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
