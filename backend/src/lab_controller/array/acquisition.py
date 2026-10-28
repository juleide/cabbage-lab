import logging
import threading
import time
from datetime import datetime
from .protocol import FrameAssembler, RowDecoder, simulation_crc
from .simulated import make_packets


def verify_simulated(packet):
    return simulation_crc(packet[:-2]) == int.from_bytes(packet[-2:], 'big')


class ArrayAcquisition:
    """Worker owns all decoder state; only copied controls/latest frame cross threads."""
    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.mode = 'press'
        self.zero = False
        self.paused = False
        self.generation = 0
        self.latest = None
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True, name='array-simulation')
        self.thread.start()

    def configure(self, mode=None, zero=None, paused=None):
        changed = False
        with self.lock:
            next_values = (self.mode if mode is None else mode, self.zero if zero is None else zero,
                           self.paused if paused is None else paused)
            if next_values != (self.mode, self.zero, self.paused):
                self.mode, self.zero, self.paused = next_values
                self.generation += 1
                self.latest = None
                changed = True
        if changed:
            self.wake.set()

    def snapshot(self):
        with self.lock:
            return self.latest

    def status(self):
        with self.lock:
            return {'mode': self.mode, 'generation': self.generation, 'paused': self.paused, 'error': self.error}

    def run(self):
        decoder = RowDecoder(verify_simulated)
        assembler = FrameAssembler()
        generation = -1
        sequence = 0
        frame_number = 0
        try:
            while not self.stopping.is_set():
                start = time.monotonic()
                with self.lock:
                    mode, zero, paused, current = self.mode, self.zero, self.paused, self.generation
                if generation != current:
                    decoder.reset()
                    assembler.reset()
                    generation = current
                assembler.expire(start)
                if not paused:
                    payload = make_packets(frame_number, mode, start, zero)
                    # Deliberately split across row boundaries, exercising half/sticky packets.
                    for offset in range(0, len(payload), 997):
                        for row in decoder.feed(payload[offset:offset + 997]):
                            values = assembler.feed(row)
                            if values is None:
                                continue
                            sequence += 1
                            frame = {
                                'sequence': sequence, 'deviceFrame': row.frame,
                                'capturedAt': datetime.now().astimezone().isoformat(timespec='milliseconds'),
                                'width': 64, 'height': 64, 'values': values,
                                'mode': mode, 'generation': current, 'source': 'simulation',
                                'stats': {'validFrames': assembler.valid_frames, 'crcErrors': decoder.crc_errors,
                                          'droppedFrames': assembler.dropped_frames, 'duplicateRows': assembler.duplicate_rows},
                            }
                            with self.lock:
                                if current == self.generation:
                                    self.latest = frame
                    frame_number = (frame_number + 1) % 256
                self.wake.wait(max(0, start + 0.04 - time.monotonic()))
                self.wake.clear()
        except Exception as exc:
            logging.exception('模拟阵列采集异常')
            with self.lock:
                self.error = str(exc)
                self.latest = None

    def close(self):
        self.stopping.set()
        self.wake.set()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError('阵列采集线程未能退出')
