"""Offline motion codecs. Not connected to RPC or any serial write path.

Missing mechanical limits and motion parameter mappings deliberately prevent
start/home/enable commands. An encoded stop is not proof of a stopped device.
"""
import re
import struct

from .modbus import crc16, frame


def motor_stop_request(station, *, emergency=False):
    if type(station) is not int or not 1 <= station <= 247:
        raise ValueError('电机站号必须为 1～247，禁止广播')
    if type(emergency) is not bool:
        raise ValueError('急停标志必须为布尔值')
    return frame(struct.pack('>BBHH', station, 6, 0x004E,
                             0x0040 if emergency else 0x0020))


def motor_stop_ack(request, response):
    """Validate one complete response; return acknowledgement, never completion.

    A local RS485 echo is indistinguishable from a function-06 reply. The
    eventual transport must disable adapter echo and independently poll status.
    """
    if (len(request) != 8 or request[1] != 6
            or not 1 <= request[0] <= 247
            or request[2:6] not in (b'\x00\x4e\x00\x20', b'\x00\x4e\x00\x40')
            or crc16(request[:-2]) != int.from_bytes(request[-2:], 'little')):
        raise ValueError('不是受支持的停止请求')
    if len(response) not in (5, 8):
        raise ValueError('停止应答长度无效')
    if crc16(response[:-2]) != int.from_bytes(response[-2:], 'little'):
        raise ValueError('停止应答 CRC 错误')
    if response[0] != request[0]:
        raise ValueError('停止应答站号不匹配')
    if len(response) == 5 and response[1] == 0x86:
        raise ValueError(f'Modbus 停止异常：0x{response[2]:02X}')
    if response != request:
        raise ValueError('停止应答地址、功能码或数值不匹配')
    return {'acknowledged': True, 'motionConfirmed': False}


def motor_status(word):
    if type(word) is not int or not 0 <= word <= 0xFFFF:
        raise ValueError('电机状态字必须为 uint16')
    return dict(zip(('inPosition', 'homed', 'running', 'fault', 'enabled',
                     'positiveLimit', 'negativeLimit'),
                    (bool(word & (1 << bit)) for bit in range(7))))


def lift_stop_request():
    return bytes.fromhex('AA 03 04 00 FF')


class LiftFeedbackParser:
    """Bounded incremental decoder for known RS232 feedback only.

    No requests, clear-error commands or guessed RS485 queries are generated.
    Invalid and unknown frames are counted; no decoded event implies stopped.
    """
    def __init__(self):
        self.buffer = bytearray()
        self.rejected = 0

    def feed(self, data):
        events = []
        # Byte-wise processing keeps retained data bounded even for huge input.
        for byte in data:
            self.buffer.append(byte)
            while self.buffer:
                if self.buffer[0] != 0xAA:
                    del self.buffer[0]
                    self.rejected += 1
                    continue
                if len(self.buffer) < 2:
                    break
                length = self.buffer[1]
                if length not in (3, 7):
                    del self.buffer[0]
                    self.rejected += 1
                    continue
                if len(self.buffer) < length + 2:
                    break
                packet = bytes(self.buffer[:length + 2])
                event = None
                if packet[-1] == 0xFF:
                    if (length == 7 and packet[2] == 1
                            and re.fullmatch(rb'[0-9]{3}\.[0-9]', packet[3:-1])):
                        digits = packet[3:-1]
                        mm = int(digits[:3]) * 10 + int(digits[4:])
                        event = {'kind': 'position', 'positionMm': mm,
                                 'unitVerified': False}
                    elif length == 3 and packet[2] == 9:
                        event = {'kind': 'error', 'code': packet[3],
                                 'knownFault': packet[3] in (1, 2)}
                if event is None:
                    del self.buffer[0]
                    self.rejected += 1
                else:
                    del self.buffer[:length + 2]
                    events.append(event)
        return events
