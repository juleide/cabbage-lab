"""Fixed-parameter JOG codecs. No transport, enable, release or arbitrary writes."""
import struct

from .modbus import crc16, frame
from ..storage.hardware import validate_motor_operation


def station_id(station):
    if type(station) is not int or not 1 <= station <= 247:
        raise ValueError('电机站号必须为 1～247，禁止广播')
    return station


def jog_setup(station, operation):
    station_id(station)
    errors = validate_motor_operation(operation, complete=True)
    if errors:
        raise ValueError('；'.join(errors))
    values = (operation['direction'] * operation['speedRpm'] & 0xFFFF,
              operation['accelerationMs'], operation['decelerationMs'])
    return tuple(frame(struct.pack('>BBHH', station, 6, address, value))
                 for address, value in zip((0x0030, 0x0031, 0x0032), values))


def jog_trigger(station):
    return frame(struct.pack('>BBHH', station_id(station), 6, 0x004E, 0x0008))


def jog_ack(request, response):
    """Restrict both request and echo. ACK is not proof of physical motion."""
    if (not isinstance(request, bytes) or len(request) != 8 or request[1] != 6
            or not 1 <= request[0] <= 247
            or crc16(request[:-2]) != int.from_bytes(request[-2:], 'little')):
        raise ValueError('不是受限电机 JOG 请求')
    address, value = struct.unpack('>HH', request[2:6])
    signed = value if value < 0x8000 else value - 0x10000
    if not ((address == 0x0030 and 1 <= abs(signed) <= 3000)
            or (address in (0x0031, 0x0032) and 1 <= value <= 2000)
            or (address == 0x004E and value == 0x0008)):
        raise ValueError('禁止非 JOG 参数/触发请求')
    if (not isinstance(response, bytes) or len(response) not in (5, 8)
            or crc16(response[:-2]) != int.from_bytes(response[-2:], 'little')):
        raise ValueError('JOG 应答长度或 CRC 错误')
    if response[0] != request[0]:
        raise ValueError('JOG 应答站号不匹配')
    if len(response) == 5 and response[1] == 0x86:
        raise ValueError(f'Modbus JOG 异常：0x{response[2]:02X}')
    if response != request:
        raise ValueError('JOG 应答功能码、地址或数值不匹配')
    return dict(acknowledged=True, physicalMotionConfirmed=False)


def motor_speed(word):
    if type(word) is not int or not 0 <= word <= 0xFFFF:
        raise ValueError('电机速度寄存器必须为 uint16')
    return word if word < 0x8000 else word - 0x10000
