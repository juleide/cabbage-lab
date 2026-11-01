"""Offline safety codec checks; never opens a serial port."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend' / 'src'))
from lab_controller.devices.modbus import frame
from lab_controller.devices.motion_protocol import (
    LiftFeedbackParser, lift_stop_request, motor_status, motor_stop_ack,
    motor_stop_request, motor_position,
)


class MotionProtocolTests(unittest.TestCase):
    def test_position_words_preserve_bits_without_signed_guess(self):
        for words, expected in (([0, 5000], 5000), ([0x1234, 0x5678], 0x12345678),
                                ([0x8000, 0], 0x80000000), ([65535, 65535], 0xFFFFFFFF)):
            result = motor_position(words)
            self.assertEqual(result['rawUnsigned'], expected)
            self.assertEqual([result['highWord'], result['lowWord']], words)
            self.assertFalse(result['interpretationVerified'])
        for words in ([], [1], [1, 2, 3], [True, 0], [0, 1.0], [-1, 0], [65536, 0], '00'):
            with self.assertRaises(ValueError):
                motor_position(words)

    def test_stop_vectors(self):
        self.assertEqual(motor_stop_request(1).hex(), '0106004e0020e805')
        self.assertEqual(motor_stop_request(1, emergency=True).hex(), '0106004e0040e82d')
        self.assertEqual(lift_stop_request().hex(), 'aa030400ff')

    def test_forbidden_station_and_types(self):
        for station in (0, 248, 254, True, 1.0, '1'):
            with self.assertRaises(ValueError):
                motor_stop_request(station)
        with self.assertRaises(ValueError):
            motor_stop_request(1, emergency=1)

    def test_ack_not_completion(self):
        request = motor_stop_request(2)
        self.assertEqual(motor_stop_ack(request, request),
                         {'acknowledged': True, 'motionConfirmed': False})
        for bad in (request[:-1], request[:-1] + b'\x00',
                    motor_stop_request(1), motor_stop_request(2, emergency=True),
                    frame(bytes.fromhex('028604'))):
            with self.assertRaises(ValueError):
                motor_stop_ack(request, bad)
        with self.assertRaises(ValueError):
            motor_stop_ack(frame(bytes.fromhex('0206004e0008')),
                           frame(bytes.fromhex('0206004e0008')))

    def test_status(self):
        status = motor_status(0x7F)
        self.assertTrue(all(status.values()))
        self.assertFalse(any(motor_status(0).values()))
        self.assertTrue(motor_status(4)['running'])
        self.assertFalse(motor_status(4)['fault'])
        for value in (-1, 65536, True):
            with self.assertRaises(ValueError):
                motor_status(value)

    def test_split_and_coalesced_feedback(self):
        parser = LiftFeedbackParser()
        packet = bytes.fromhex('AA07013031322E33FF')
        for split in range(1, len(packet)):
            parser = LiftFeedbackParser()
            self.assertEqual(parser.feed(packet[:split]), [])
            self.assertEqual(parser.feed(packet[split:])[0]['positionMm'], 123)
        events = parser.feed(packet + bytes.fromhex('AA030901FFAA030900FF'))
        self.assertEqual(len(events), 3)
        self.assertFalse(events[0]['unitVerified'])
        self.assertTrue(events[1]['knownFault'])
        self.assertFalse(events[2]['knownFault'])

    def test_noise_bad_payload_and_bounded_buffer(self):
        parser = LiftFeedbackParser()
        invalid = bytes.fromhex('AA070130312D2E33FFAA030400FF')
        self.assertEqual(parser.feed(b'x' * 100000 + invalid), [])
        self.assertGreater(parser.rejected, 100000)
        self.assertLessEqual(len(parser.buffer), 8)
        self.assertEqual(parser.feed(bytes.fromhex('AA07013030302E30FF'))[0]['positionMm'], 0)


if __name__ == '__main__':
    unittest.main()
