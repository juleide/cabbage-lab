"""Continuous sensor tests using only in-memory serial adapters."""
import copy
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend' / 'src'))
from lab_controller.core.controller import Controller
from lab_controller.devices.modbus import frame
from lab_controller.devices.sensors import SensorSession, SensorManager
from lab_controller.storage.hardware import defaults
from lab_controller.storage.records import RecordStore


class Port:
    def __init__(self, values, fail_after=None):
        self.values = values
        self.fail_after = fail_after
        self.pending = bytearray()
        self.writes = []
        self.closed = False

    def reset_input_buffer(self):
        self.pending.clear()

    def write(self, data):
        self.writes.append(data)
        if self.fail_after is None or len(self.writes) <= self.fail_after:
            payload = struct.pack('>' + 'H' * len(self.values), *self.values)
            self.pending.extend(frame(bytes([data[0], 3, len(payload)]) + payload))
        return len(data)

    def read(self, size):
        value = bytes(self.pending[:3])
        del self.pending[:3]
        if not value:
            time.sleep(0.001)
        return value

    def close(self):
        self.closed = True


def config():
    value = defaults()
    for section, port in [('tension', 'TEST1'), ('displacement', 'TEST2')]:
        value[section]['serial'].update(port=port, baud=9600, timeoutMs=50, intervalMs=10)
        value[section]['station'] = 1
    value['tension'].update(decimals=2, unit='N')
    value['displacement'].update(model='p', lower=0, upper=700)
    return value


class SensorTests(unittest.TestCase):
    def wait(self, predicate, controller=None):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if controller:
                controller.poll_hardware()
            if predicate():
                return
            time.sleep(0.005)
        self.fail('等待传感器状态超时')

    def test_two_connections_record_raw_feedback_without_guessing_homepage_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            ports = []

            def factory(settings):
                port = Port([1234, 0] if settings['port'] == 'TEST1' else [2500])
                ports.append(port)
                return port

            controller.sensors.factory = factory
            try:
                value = config()
                controller.request('hardware.save', {'config': value})
                for section in ('tension', 'displacement'):
                    controller.request('hardware.sensors.connect', {'section': section})
                self.wait(lambda: all(item['quality'] == 'valid' for item in controller.sensors.snapshot().values()), controller)
                statuses = controller.request('hardware.sensors.status', {})
                self.assertEqual(statuses['tension']['reading']['value'], 12.34)
                self.assertEqual(statuses['displacement']['reading']['value'], 350)
                self.assertEqual(len(ports), 2)
                controller.request('hardware.save', {'config': value})
                self.assertFalse(controller.pending_connections)
                for method, params in [('hardware.verify', {'section': 'tension'}),
                                       ('device.command', {'type': 'toggle', 'device': 'motor1'})]:
                    with self.assertRaises(ValueError):
                        controller.request(method, params)
                self.assertFalse(any(controller.state['devices'].values()))
                self.assertEqual(controller.records.list(controller.state['database']), [])
                controller.request('device.command', {'type': 'emergency'})
                self.wait(lambda: not controller.sensors.active(), controller)
                controller.poll_hardware()
                runs = controller.request('hardware.sensors.records.list', {})
                self.assertEqual(len(runs), 2)
                for run in runs:
                    self.assertEqual(run['source'], 'hardware')
                    self.assertEqual(run['status'], 'completed')
                    self.assertEqual(run['config']['serial']['port'], value[run['section']]['serial']['port'])
                    events = controller.request('hardware.sensors.records.read', {'sessionId': run['id'], 'offset': 0, 'limit': 100})
                    self.assertEqual(events[-1]['kind'], 'end')
                    self.assertTrue(any(event['quality'] == 'valid' for event in events))
                    self.assertTrue(all(event['source'] == 'hardware' for event in events))
                self.assertTrue(all(port.closed for port in ports))
            finally:
                controller.close()
            reopened = RecordStore(Path(directory) / 'data' / 'experiments.sqlite3')
            self.assertEqual(len(reopened.sensor_runs()), 2)
            reopened.close()

    def test_zero_retains_absolute_data_and_reconnect_resets_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            controller.sensors.factory = lambda settings: Port([2500])
            try:
                controller.request('hardware.save', {'config': config()})
                controller.request('hardware.sensors.connect', {'section': 'displacement'})
                job = controller.sensors.sessions['displacement']
                self.wait(lambda: job.snapshot()['quality'] == 'valid', controller)
                controller.request('hardware.sensors.zero', {'section': 'displacement'})
                self.wait(lambda: job.snapshot()['quality'] == 'valid' and job.snapshot()['reading']['zeroOffset'] == 350, controller)
                reading = job.snapshot()['reading']
                self.assertEqual((reading['raw'], reading['absoluteValue'], reading['value']), (2500, 350, 0))
                controller.request('hardware.sensors.disconnect', {'section': 'displacement'})
                self.wait(lambda: not controller.sensors.active(), controller)
                controller.poll_hardware()
                events = controller.records.read_sensor(job.status['sessionId'], 0, 100)
                self.assertTrue(any(event['kind'] == 'zero' and event['zeroOffset'] == 350 for event in events))
                controller.request('hardware.sensors.connect', {'section': 'displacement'})
                fresh = controller.sensors.sessions['displacement']
                self.wait(lambda: fresh.snapshot()['quality'] == 'valid', controller)
                self.assertNotEqual(fresh.status['sessionId'], job.status['sessionId'])
                self.assertEqual(fresh.snapshot()['reading']['value'], 350)
            finally:
                controller.close()

    def test_stale_timeout_no_retry_and_failure_record(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            port = Port([1234, 0], fail_after=1)
            controller.sensors.factory = lambda settings: port
            try:
                value = config()
                value['tension']['serial']['timeoutMs'] = 60000
                controller.request('hardware.save', {'config': value})
                controller.request('hardware.sensors.connect', {'section': 'tension'})
                job = controller.sensors.sessions['tension']
                self.wait(lambda: len(port.writes) >= 2, controller)
                with job.lock:
                    job.last_monotonic = time.monotonic() - 2
                status = controller.request('hardware.sensors.status', {})['tension']
                self.assertEqual(status['quality'], 'stale')
                self.assertIsNone(status['reading'])
                self.assertEqual(status['lastValid']['value'], 12.34)
                controller.request('hardware.sensors.disconnect', {'section': 'tension'})
                self.wait(lambda: not controller.sensors.active(), controller)
                controller.poll_hardware()
                events = controller.records.read_sensor(job.status['sessionId'], 0, 100)
                self.assertEqual(sum(event['quality'] == 'stale' for event in events), 1)
                self.assertEqual(len(port.writes), 2)
            finally:
                controller.close()
        job = SensorSession('tension', config()['tension'], lambda settings: Port([1, 0], fail_after=1))
        job.thread.start()
        job.thread.join(timeout=1)
        self.assertEqual(job.snapshot()['state'], 'failed')
        self.assertIsNone(job.snapshot()['reading'])
        self.assertEqual(job.snapshot()['quality'], 'invalid')

    def test_buffer_overflow_is_failure_not_silent_loss(self):
        port = Port([1, 0])
        job = SensorSession('tension', config()['tension'], lambda settings: port, capacity=2)
        job.thread.start()
        job.thread.join(timeout=1)
        self.assertFalse(job.thread.is_alive())
        events, status = job.collect()
        self.assertEqual(len(events), 2)
        self.assertIn('缓冲已满', status['error'])
        self.assertTrue(port.closed)

    def test_resource_alias_and_closed_manager(self):
        manager = SensorManager(lambda settings: Port([1, 0]))
        settings = copy.deepcopy(config()['tension'])
        settings['serial']['port'] = 'COM3'
        session = manager.connect('tension', settings)
        session.thread.start()
        try:
            other = copy.deepcopy(config()['displacement'])
            other['serial']['port'] = 'com3'
            with self.assertRaises(ValueError):
                manager.connect('displacement', other)
        finally:
            manager.close()
        with self.assertRaises(ValueError):
            manager.connect('tension', settings)

    def test_validation_open_failure_and_interrupted_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = Controller(Path(directory), lambda *args: None)
            try:
                for method, params in [('hardware.sensors.connect', {'section': 'motors'}),
                                       ('hardware.sensors.status', {'extra': 1}),
                                       ('hardware.sensors.zero', {'section': 'tension'}),
                                       ('hardware.sensors.records.read', {'sessionId': 'none', 'offset': -1, 'limit': 1000})]:
                    with self.assertRaises(ValueError):
                        controller.request(method, params)
                with self.assertRaises(ValueError):
                    controller.request('hardware.sensors.connect', {'section': 'tension'})
                controller.request('hardware.save', {'config': config()})

                def fail(settings):
                    raise OSError('port busy')

                controller.sensors.factory = fail
                controller.request('hardware.sensors.connect', {'section': 'tension'})
                self.wait(lambda: not controller.sensors.active(), controller)
                controller.poll_hardware()
                run = controller.records.sensor_runs()[0]
                self.assertEqual(run['status'], 'failed')
                self.assertIn('port busy', run['error'])
                self.assertIsNone(controller.records.read_sensor(run['id'], 0, 100)[0]['value'])
                self.assertEqual(controller.request('state.get', {})['state']['running'], False)
                status = dict(sessionId='interrupted-test', section='tension', startedAt=time.time(), configVersion='test')
                controller.records.begin_sensor(status, config()['tension'])
            finally:
                controller.close()
            reopened = RecordStore(Path(directory) / 'data' / 'experiments.sqlite3')
            self.assertEqual(next(run for run in reopened.sensor_runs() if run['id'] == 'interrupted-test')['status'], 'interrupted')
            reopened.close()


if __name__ == '__main__':
    unittest.main()
