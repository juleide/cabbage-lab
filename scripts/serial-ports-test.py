"""Serial discovery tests. Never accesses physical ports."""
import builtins
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend' / 'src'))
from lab_controller.devices.ports import list_ports


class SerialPortsTests(unittest.TestCase):
    def discovery(self, ports):
        return patch.dict(sys.modules, {
            'serial': SimpleNamespace(),
            'serial.tools': SimpleNamespace(list_ports=SimpleNamespace(comports=ports)),
        })

    def test_metadata_and_sorting(self):
        def port(name):
            return SimpleNamespace(device=name, description='USB adapter', manufacturer=None,
                                   vid=123, pid=456, serial_number=None, location='1-2')
        enumerate_ports = Mock(return_value=[port('COM4'), port('COM3')])
        with self.discovery(enumerate_ports):
            result = list_ports()['ports']
        self.assertEqual([item['port'] for item in result], ['COM3', 'COM4'])
        self.assertEqual(result[0]['vid'], 123)
        self.assertIsNone(result[0]['serialNumber'])
        enumerate_ports.assert_called_once_with()

    def test_empty_is_success(self):
        with self.discovery(Mock(return_value=[])):
            self.assertEqual(list_ports(), {'ports': []})

    def test_enumeration_error(self):
        with self.discovery(Mock(side_effect=OSError('permission denied'))):
            with self.assertRaisesRegex(ValueError, '扫描失败'):
                list_ports()

    def test_missing_dependency(self):
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == 'serial.tools':
                raise ImportError('missing pyserial')
            return original_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=guarded_import):
            with self.assertRaisesRegex(ValueError, 'requirements.txt'):
                list_ports()


if __name__ == '__main__':
    unittest.main()
