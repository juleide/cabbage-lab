"""Safety drafts and offline planning: never connects to a real device."""
import copy
import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.core.controller import Controller
from lab_controller.devices.motion_safety import assess, preview
from lab_controller.storage.hardware import defaults as hardware_defaults
from lab_controller.storage.motion_safety import MotionSafetyStore, defaults, hardware_version, validate


def hardware():
    value = hardware_defaults()
    value['motors'].update(motor1=1, motor2=2)
    value['motors']['serial'].update(port='OFFLINE-MOTORS', baud=9600)
    value['lift']['serial']['port'] = 'OFFLINE-LIFT'
    return value


def profile():
    value = defaults()
    value.update(hardwareVersion=hardware_version(hardware()), machineId='TEST-ONLY',
                 reviewedBy='test-fixture', reviewedAt=date.today().isoformat())
    value['evidence'] = {key: 'TEST REFERENCE ONLY, NOT VERIFIED' for key in value['evidence']}
    for key in ('motor1', 'motor2'):
        value[key].update(minimumMm=0, maximumMm=100, maxStepMm=5, maxDurationMs=1000,
                          pulsesPerMm=100, direction=1, zeroPulse=0, maxSpeedRpm=10)
    value['lift'].update(minimumMm=100, maximumMm=2000, maxStepMm=100, maxDurationMs=1000,
                         feedbackMaxAgeMs=500, stopTimeoutMs=1000)
    return value


def params(store, target='motor1', **changes):
    result = dict(target=target, fromMm=0, positionMm=1.25, durationMs=100,
                  expectedVersion=store.version, expectedHardwareVersion=hardware_version(hardware()))
    if target != 'lift':
        result['speedRpm'] = 5
    else:
        result.update(fromMm=120, positionMm=123)
    result.update(changes)
    return result


class SafetyTests(unittest.TestCase):
    def store(self, root):
        store = MotionSafetyStore(Path(root) / 'config' / 'motion-safety.json')
        store.save(profile(), store.version)
        return store

    def test_defaults_are_incomplete_and_cannot_grant_permission(self):
        self.assertEqual(validate(defaults()), [])
        self.assertTrue(validate(defaults(), complete=True))
        self.assertEqual(validate(profile(), complete=True), [])
        with tempfile.TemporaryDirectory() as root:
            store = MotionSafetyStore(Path(root) / 'safety.json')
            value = assess(store, hardware(), {})
            self.assertFalse(store.path.exists())
            self.assertFalse(value['bindingMatches'])
            self.assertTrue(all(not target['canPreview'] and not target['canExecute'] for target in value['targets'].values()))

    def test_shape_schema_and_forged_permission_flags_are_rejected(self):
        for change in (None, [], {'schemaVersion': 1}):
            self.assertTrue(validate(change))
        for key, item in [('schemaVersion', 2), ('schemaVersion', True), ('enabled', True),
                          ('hardwareVersion', 'not-a-hash'), ('machineId', 'x' * 513)]:
            value = profile()
            value[key] = item
            self.assertTrue(validate(value), (key, item))
        for item in (True, '1', float('nan'), float('inf'), 10 ** 400):
            value = profile()
            value['motor1']['pulsesPerMm'] = item
            self.assertTrue(validate(value))

    def test_ranges_direction_resolution_and_time_constraints(self):
        for target, field, item in [('motor1', 'minimumMm', 100), ('motor1', 'maxStepMm', 101),
                ('motor1', 'direction', 0), ('motor1', 'direction', 1.0), ('motor1', 'direction', 1e308),
                ('motor1', 'zeroPulse', -1), ('motor1', 'zeroPulse', 1.0), ('motor1', 'zeroPulse', 2 ** 31),
                ('motor1', 'pulsesPerMm', 0), ('motor1', 'maxSpeedRpm', -1),
                ('lift', 'minimumMm', -1), ('lift', 'maximumMm', 10000), ('lift', 'maxStepMm', 0.5),
                ('lift', 'maxDurationMs', 60001), ('lift', 'stopTimeoutMs', 1.5)]:
            value = profile()
            value[target][field] = item
            self.assertTrue(validate(value), (target, field, item))
        value = profile()
        value['motor1'].update(direction=-1, zeroPulse=10000)
        self.assertEqual(validate(value), [])
        value['motor1']['zeroPulse'] = 0
        self.assertTrue(validate(value))

    def test_material_references_and_dates_are_records_not_attestations(self):
        value = profile()
        value['evidence']['motorParameters'] = ''
        self.assertTrue(validate(value, complete=True, target='motor1'))
        self.assertEqual(validate(value, complete=True, target='lift'), [])
        for item in ('2026-99-99', '20261101', (date.today() + timedelta(days=1)).isoformat()):
            value['reviewedAt'] = item
            self.assertTrue(validate(value))
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            assessment = assess(store, hardware(), {})
            self.assertFalse(assessment['evidenceVerified'])
            self.assertTrue(all(target['canPreview'] and not target['canExecute'] for target in assessment['targets'].values()))

    def test_binding_invalidated_by_connection_changes_not_sensor_changes(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            for section, key, item in [('motors', 'motor1', 3), ('lift', 'interface', 'RS485')]:
                value = hardware()
                value[section][key] = item
                result = assess(store, value, {})
                self.assertFalse(result['bindingMatches'])
                self.assertFalse(any(target['canPreview'] for target in result['targets'].values()))
            value = hardware()
            value['motors']['serial']['port'] = 'OTHER'
            self.assertFalse(assess(store, value, {})['bindingMatches'])
            value = hardware()
            value['tension']['serial']['port'] = 'UNRELATED'
            self.assertTrue(assess(store, value, {})['bindingMatches'])

    def test_full_profile_and_good_feedback_still_never_enable_execution(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            session = dict(state='monitoring', faultLatched=False, readings={
                'motor1': dict(quality='valid', running=False, fault=False, enabled=True),
                'motor2': dict(quality='valid', running=False, fault=False, enabled=True)})
            assessment = assess(store, hardware(), {'motors': session})
            target = assessment['targets']['motor1']
            self.assertTrue(target['canPreview'])
            self.assertFalse(target['canExecute'])
            self.assertTrue({'EXECUTION_NOT_IMPLEMENTED', 'EVIDENCE_NOT_VERIFIED', 'IDENTITY_NOT_VERIFIED',
                             'PROTOCOL_UNCONFIRMED', 'POSITION_UNAVAILABLE'} <= {reason['code'] for reason in target['reasons']})
            session['readings']['motor1']['position'] = dict(quality='valid', rawUnsigned=125,
                                                           interpretationVerified=False)
            target = assess(store, hardware(), {'motors': session})['targets']['motor1']
            codes = {reason['code'] for reason in target['reasons']}
            self.assertNotIn('POSITION_UNAVAILABLE', codes)
            self.assertIn('POSITION_INTERPRETATION_UNVERIFIED', codes)
            self.assertFalse(target['canExecute'])
            session['readings']['motor1']['position']['quality'] = 'stale'
            codes = {reason['code'] for reason in assess(store, hardware(), {'motors': session})['targets']['motor1']['reasons']}
            self.assertIn('POSITION_UNAVAILABLE', codes)
            session['faultLatched'] = True
            session['readings']['motor1'].update(quality='stale', positiveLimit=True)
            target = assess(store, hardware(), {'motors': session}, stopped=True)['targets']['motor1']
            self.assertTrue({'FAULT_LATCHED', 'FEEDBACK_UNAVAILABLE', 'DEVICE_NOT_IDLE', 'SOFTWARE_EMERGENCY'} <=
                            {reason['code'] for reason in target['reasons']})

    def test_preview_motor_endpoint_words_and_reverse_calibration(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            result = preview(store, hardware(), assess(store, hardware(), {}), params(store))
            self.assertEqual((result['fromPulse'], result['targetPulse'], result['highWord'], result['lowWord']), (0, 125, 0, 125))
            self.assertFalse(result['executable'])
            value = profile()
            value['motor1'].update(pulsesPerMm=100000, direction=-1, zeroPulse=10000000)
            store.save(value, store.version)
            result = preview(store, hardware(), assess(store, hardware(), {}), params(store, positionMm=1))
            self.assertEqual(result['targetPulse'], 9900000)
            self.assertEqual(result['highWord'] * 65536 + result['lowWord'], 9900000)

    def test_preview_has_no_rounding_and_respects_distance_speed_and_duration(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            for changes in ({'positionMm': 0}, {'fromMm': -1}, {'positionMm': 101}, {'positionMm': 6},
                    {'durationMs': 0}, {'durationMs': 1001}, {'durationMs': 1.5}, {'durationMs': True},
                    {'speedRpm': 11}, {'speedRpm': 0}, {'positionMm': 0.001}, {'positionMm': float('nan')},
                    {'fromMm': 0.1 + 0.2}, {'unexpected': 1}, {'expectedVersion': 'stale'},
                    {'expectedHardwareVersion': 'stale'}, {'target': 'other'}):
                with self.assertRaises(ValueError, msg=str(changes)):
                    preview(store, hardware(), assess(store, hardware(), {}), params(store, **changes))
            value = profile()
            value['motor1']['pulsesPerMm'] = 10
            store.save(value, store.version)
            result = preview(store, hardware(), assess(store, hardware(), {}), params(store, fromMm=0.1, positionMm=0.3))
            self.assertEqual(result['targetPulse'], 3)

    def test_preview_lift_integer_mm_to_ascii_cm_without_frames(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            result = preview(store, hardware(), assess(store, hardware(), {}), params(store, 'lift'))
            self.assertEqual(result['positionAsciiCm'], '012.3')
            self.assertNotIn('frame', result)
            for changes in ({'positionMm': 123.1}, {'fromMm': 120.1}, {'positionMm': 300}, {'speedRpm': 1}):
                with self.assertRaises(ValueError):
                    preview(store, hardware(), assess(store, hardware(), {}), params(store, 'lift', **changes))

    def test_store_round_trip_deep_copy_and_optimistic_version(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            self.assertEqual(MotionSafetyStore(store.path).value, profile())
            previous = store.version
            value = profile()
            value['machineId'] = 'NEW RECORD'
            saved = store.save(value, previous)
            saved['machineId'] = 'mutated'
            value['machineId'] = 'also mutated'
            self.assertEqual(store.value['machineId'], 'NEW RECORD')
            with self.assertRaisesRegex(ValueError, '版本已变化'):
                store.save(profile(), previous)

    def test_corrupt_file_protected_and_external_changes_disable_preview(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            for raw in ('{broken', '{"schemaVersion": 999}', '{"canExecute": true}'):
                store.path.write_text(raw)
                broken = MotionSafetyStore(store.path)
                self.assertIsNotNone(broken.error)
                with self.assertRaises(ValueError):
                    broken.save(profile(), broken.version)
                self.assertEqual(store.path.read_text(), raw)
            self.assertIn('外部修改', store.current_error())
            assessment = assess(store, hardware(), {})
            self.assertFalse(assessment['targets']['motor1']['canPreview'])
            with self.assertRaises(ValueError):
                preview(store, hardware(), assessment, params(store))
            with self.assertRaises(ValueError):
                store.save(profile(), store.version)

    def test_failed_replace_preserves_saved_profile(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.store(root)
            before = store.path.read_bytes()
            value = profile()
            value['machineId'] = 'UNSAVED'
            with patch.object(Path, 'replace', side_effect=OSError('disk error')):
                with self.assertRaises(OSError):
                    store.save(value, store.version)
            self.assertEqual(store.path.read_bytes(), before)
            self.assertEqual(store.value, profile())

    def test_duplicate_fields_and_oversized_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'safety.json'
            for raw in ('{"schemaVersion": 1, "schemaVersion": 1}', ' ' * 65537):
                path.write_text(raw)
                store = MotionSafetyStore(path)
                self.assertTrue(store.error)
                self.assertFalse(assess(store, hardware(), {})['targets']['motor1']['canPreview'])
                with self.assertRaises(ValueError):
                    store.save(profile(), store.version)
                self.assertEqual(path.read_text(), raw)

    def test_controller_save_preview_and_restart_do_not_open_ports(self):
        with tempfile.TemporaryDirectory() as root:
            controller = Controller(Path(root), lambda *args: None)
            def forbidden(settings):
                self.fail('安全草稿和离线规划不能打开串口')
            controller.motion.factory = forbidden
            controller.sensors.factory = forbidden
            controller.verification.factory = forbidden
            try:
                controller.request('hardware.save', {'config': hardware()})
                current = controller.request('hardware.safety.get', {})
                response = controller.request('hardware.safety.save', dict(config=profile(),
                    expectedVersion=current['assessment']['configVersion'], expectedHardwareVersion=current['assessment']['hardwareVersion']))
                result = controller.request('hardware.safety.preview', params(controller.safety))
                self.assertFalse(result['executable'])
                self.assertFalse(response['assessment']['targets']['motor1']['canExecute'])
                self.assertFalse(controller.motion.active())
                self.assertFalse(controller.sensors.active())
                self.assertFalse(any(controller.device.outputs.values()))
                self.assertEqual(controller.records.list(controller.state['database']), [])
                self.assertTrue(any('不执行' in log['message'] for log in controller.records.logs()))
            finally:
                controller.close()
            restarted = Controller(Path(root), lambda *args: None)
            try:
                self.assertEqual(restarted.request('hardware.safety.get', {})['config'], profile())
                self.assertFalse(restarted.motion.active())
            finally:
                restarted.close()

    def test_controller_interlocks_and_rebinding_are_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            controller = Controller(Path(root), lambda *args: None)
            try:
                controller.request('hardware.save', {'config': hardware()})
                saved = dict(config=profile(), expectedVersion=controller.safety.version,
                             expectedHardwareVersion=hardware_version(hardware()))
                for manager in (controller.motion, controller.sensors, controller.verification):
                    with patch.object(manager, 'active', return_value=True):
                        with self.assertRaises(ValueError):
                            controller.request('hardware.safety.save', saved)
                controller.request('hardware.safety.save', saved)
                changed = hardware()
                changed['motors']['motor1'] = 3
                controller.request('hardware.save', {'config': changed})
                self.assertFalse(controller.request('hardware.safety.status', {})['bindingMatches'])
                saved['expectedVersion'] = controller.safety.version
                with self.assertRaises(ValueError):
                    controller.request('hardware.safety.save', saved)
                saved['config']['hardwareVersion'] = saved['expectedHardwareVersion'] = hardware_version(changed)
                self.assertTrue(controller.request('hardware.safety.save', saved)['assessment']['bindingMatches'])
            finally:
                controller.close()

    def test_invalid_safety_file_does_not_disable_emergency_stop(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'config' / 'motion-safety.json'
            path.parent.mkdir()
            path.write_text('{broken')
            controller = Controller(Path(root), lambda *args: None)
            try:
                controller.request('device.command', {'type': 'toggle', 'device': 'motor1'})
                controller.request('device.command', {'type': 'emergency'})
                self.assertFalse(any(controller.device.outputs.values()))
                self.assertTrue(controller.state['stopped'])
                status = controller.request('hardware.safety.status', {})
                self.assertTrue(status['error'])
                self.assertTrue(all(not target['canExecute'] for target in status['targets'].values()))
                for method, args in [('hardware.motion.execute', {}), ('hardware.safety.grant', {}),
                                     ('hardware.safety.status', {'unknown': True})]:
                    with self.assertRaises(ValueError):
                        controller.request(method, args)
            finally:
                controller.close()


if __name__ == '__main__':
    unittest.main()
