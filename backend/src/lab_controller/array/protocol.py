"""Row framing from the supplied manual; CRC is explicitly injected, never guessed."""
import time
from dataclasses import dataclass
from typing import Callable

HEADER = b'\xaa\x10\x33'
PACKET_SIZE = 136
GRID_SIZE = 64


@dataclass(frozen=True)
class Row:
    frame: int
    number: int
    values: list[int]


class RowDecoder:
    def __init__(self, verify: Callable[[bytes], bool]):
        self.verify = verify
        self.buffer = bytearray()
        self.crc_errors = 0
        self.invalid_packets = 0

    def reset(self):
        self.buffer.clear()

    def feed(self, chunk: bytes):
        # Scan incrementally: even a large input chunk cannot grow the pending buffer unboundedly.
        for offset in range(0, len(chunk), 4096):
            self.buffer.extend(chunk[offset:offset + 4096])
            while True:
                start = self.buffer.find(HEADER)
                if start < 0:
                    del self.buffer[:-2]
                    break
                if start:
                    del self.buffer[:start]
                if len(self.buffer) < 4:
                    break
                if self.buffer[3] != PACKET_SIZE:
                    self.invalid_packets += 1
                    del self.buffer[0]
                    continue
                if len(self.buffer) < PACKET_SIZE:
                    break
                packet = bytes(self.buffer[:PACKET_SIZE])
                if packet[5] >= GRID_SIZE:
                    self.invalid_packets += 1
                    del self.buffer[0]
                    continue
                if not self.verify(packet):
                    self.crc_errors += 1
                    del self.buffer[0]
                    continue
                del self.buffer[:PACKET_SIZE]
                values = [0] * GRID_SIZE
                for index in range(GRID_SIZE):
                    column = (index % 8) * 8 + index // 8
                    values[column] = int.from_bytes(packet[6 + index * 2:8 + index * 2], 'big')
                yield Row(packet[4], packet[5], values)


class FrameAssembler:
    def __init__(self, timeout=0.5):
        self.timeout = timeout
        self.frame = None
        self.started = 0.0
        self.rows = {}
        self.finished = False
        self.valid_frames = 0
        self.dropped_frames = 0
        self.duplicate_rows = 0

    def reset(self):
        self.frame = None
        self.rows.clear()
        self.finished = False

    def expire(self, current=None):
        current = time.monotonic() if current is None else current
        if self.frame is not None and not self.finished and current - self.started >= self.timeout:
            self.dropped_frames += 1
            self.rows.clear()
            self.finished = True  # Ignore late rows from this expired frame.

    def feed(self, row, current=None):
        current = time.monotonic() if current is None else current
        self.expire(current)
        if self.frame is not None and row.frame != self.frame:
            delta = (row.frame - self.frame) % 256
            if delta >= 128:
                return None  # Old rows must not replace a newer frame.
        if row.frame != self.frame:
            if self.frame is not None and not self.finished:
                self.dropped_frames += 1
            self.frame = row.frame
            self.started = current
            self.finished = False
            self.rows = {}
        if self.finished:
            return None
        if row.number in self.rows:
            self.duplicate_rows += 1
            return None
        self.rows[row.number] = row.values
        if len(self.rows) != GRID_SIZE:
            return None
        values = [value for number in range(GRID_SIZE) for value in self.rows[number]]
        self.rows.clear()
        self.finished = True
        self.valid_frames += 1
        return values
