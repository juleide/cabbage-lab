"""Offline packet fixtures; CCITT-FALSE here is not a verified device CRC."""
import math
import binascii
from lab_controller.array.protocol import HEADER, PACKET_SIZE


def simulation_crc(data):
    return binascii.crc_hqx(data, 0xFFFF)


def verify_simulated(packet):
    return simulation_crc(packet[:-2]) == int.from_bytes(packet[-2:], "big")


def make_packets(frame, mode, phase, zero):
    packets = []
    for y in range(64):
        values = []
        ny = (y - 31.5) / 31.5
        for x in range(64):
            nx = (x - 31.5) / 31.5
            if mode == 'press':
                value = math.exp(-((nx + 0.06) ** 2 / 0.31 + (ny - 0.07) ** 2 / 0.47)) * 0.88
                value += math.exp(-((nx - 0.22) ** 2 / 0.055 + (ny + 0.22) ** 2 / 0.09)) * 0.16
            else:
                value = (math.exp(-((nx + 0.4) ** 2 / 0.07 + ny ** 2 / 0.4)) + math.exp(-((nx - 0.4) ** 2 / 0.07 + ny ** 2 / 0.4))) * 0.85
            value += math.sin(phase) * 0.025 + math.sin(x * 2.3 + y * 1.8) * 0.018
            values.append(0 if zero else round(max(0, min(1, value)) * 4095))
        packet = bytearray(HEADER + bytes((PACKET_SIZE, frame, y)))
        for index in range(64):
            column = (index % 8) * 8 + index // 8
            packet.extend(values[column].to_bytes(2, 'big'))
        packet.extend(simulation_crc(packet).to_bytes(2, 'big'))
        packets.append(bytes(packet))
    return b''.join(packets)
