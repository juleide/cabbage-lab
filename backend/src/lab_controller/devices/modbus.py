"""Read-only RTU transactions. No writes, broadcast probes or automatic retries."""
import os
import struct
import time


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def frame(data):
    return data + struct.pack('<H', crc16(data))


def open_serial(settings):
    try:
        import serial
    except ImportError as exc:
        raise ValueError('缺少 PySerial，请在控制端 Python 环境安装 backend/requirements.txt') from exc
    options = dict(baudrate=int(settings['baud']), bytesize=settings['bits'],
                   parity=settings['parity'], stopbits=settings['stop'],
                   timeout=0.05, write_timeout=min(settings['timeoutMs'] / 1000, 0.2))
    if os.name == 'posix':
        options['exclusive'] = True
    port = serial.Serial(port=None, **options)
    try:
        # Set control lines before opening; some adapters may still glitch on open.
        port.dtr = False
        port.rts = False
        port.port = settings['port'].strip()
        port.open()
        return port
    except Exception:
        port.close()
        raise


class ReadOnlyBus:
    def __init__(self, port, settings, cancelled):
        self.port = port
        self.timeout = settings['timeoutMs'] / 1000
        bits = 1 + settings['bits'] + (settings['parity'] != 'N') + settings['stop']
        self.quiet = max(0.00175, 3.5 * bits / settings['baud'])
        self.cancelled = cancelled

    def read(self, station, address, count):
        if not (type(station) is int and 1 <= station <= 247
                and type(address) is int and 0 <= address <= 65535
                and type(count) is int and 1 <= count <= 125 and address + count <= 65536):
            raise ValueError('无效的 Modbus 读取参数（禁止广播及特殊扫描地址）')
        if self.cancelled.wait(self.quiet):
            raise ValueError('验证已取消')
        self.port.reset_input_buffer()
        request = frame(struct.pack('>BBHH', station, 3, address, count))
        if self.port.write(request) != len(request):
            raise ValueError('串口写入不完整')
        deadline = time.monotonic() + self.timeout
        buffer = bytearray()
        last_error = '响应超时：未收到匹配的有效报文'
        error_rank = 0
        while time.monotonic() < deadline:
            if self.cancelled.is_set():
                raise ValueError('验证已取消')
            buffer.extend(self.port.read(256))
            while len(buffer) >= 5:
                if buffer[0] != station or buffer[1] not in (3, 0x83):
                    if error_rank < 1:
                        last_error, error_rank = '响应站号或功能码不匹配', 1
                    del buffer[0]
                    continue
                length = 5 if buffer[1] == 0x83 else 5 + buffer[2]
                if buffer[1] == 3 and buffer[2] != count * 2:
                    if error_rank < 2:
                        last_error, error_rank = '响应寄存器数量不匹配', 2
                    del buffer[0]
                    continue
                if len(buffer) < length:
                    break
                response = bytes(buffer[:length])
                if crc16(response[:-2]) != int.from_bytes(response[-2:], 'little'):
                    last_error, error_rank = '响应 CRC 校验失败', 3
                    del buffer[0]
                    continue
                if response[1] == 0x83:
                    raise ValueError(f'Modbus 异常响应：0x{response[2]:02X}')
                return list(struct.unpack('>' + 'H' * count, response[3:-2]))
        raise ValueError(last_error)
