import logging
import threading
import time
from collections import deque
from .protocol import FrameAssembler, RowDecoder, simulation_crc
from .simulated import make_packets
from .processing import BaselineCorrection, statistics, timestamp


def verify_simulated(packet):
    return simulation_crc(packet[:-2]) == int.from_bytes(packet[-2:], 'big')


class ArrayAcquisition:
    """Worker owns parsing; processing/control snapshots are synchronized by one lock."""
    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stopping = threading.Event()
        self.mode = 'press'
        self.paused = False
        self.generation = 0
        self.latest = None
        self.error = None
        self.correction = BaselineCorrection()
        self.diagnostics = {'validFrames': 0, 'crcErrors': 0, 'droppedFrames': 0,
                            'duplicateRows': 0, 'captureFps': 0.0, 'lastFrameAt': None}
        self.thread = threading.Thread(target=self.run, daemon=True, name='array-simulation')
        self.thread.start()

    def configure(self, mode=None, paused=None):
        with self.lock:
            next_values = (self.mode if mode is None else mode, self.paused if paused is None else paused)
            changed = next_values != (self.mode, self.paused)
            if changed:
                self.mode, self.paused = next_values
                self.generation += 1
                self.latest = None
                self.correction.clear()
        if changed:
            self.wake.set()

    def start_correction(self):
        with self.lock:
            if self.paused or self.error or not self.latest:
                raise ValueError('阵列尚未就绪，无法进行零点修正')
            if time.monotonic() - self.last_received > 1:
                raise ValueError('阵列数据已超时')
            self.correction.start(time.monotonic())
        self.wake.set()

    def clear_correction(self):
        with self.lock:
            self.correction.clear()
            self.latest = None
        self.wake.set()

    def snapshot(self):
        with self.lock:
            return self.latest

    def status(self):
        with self.lock:
            diagnostics = self.diagnostics.copy()
            if self.paused or self.error or time.monotonic() - getattr(self, 'last_received', 0) > 1:
                diagnostics['captureFps'] = 0.0
            return {'mode': self.mode, 'generation': self.generation, 'paused': self.paused, 'error': self.error,
                    'processingVersion': self.correction.version, 'correction': self.correction.status(),
                    'diagnostics': diagnostics}

    def run(self):
        decoder = RowDecoder(verify_simulated)
        assembler = FrameAssembler()
        captures = deque(maxlen=100)
        generation = -1
        sequence = frame_number = 0
        try:
            while not self.stopping.is_set():
                start = time.monotonic()
                with self.lock:
                    mode, paused, current = self.mode, self.paused, self.generation
                    self.correction.expire(start)
                if generation != current:
                    decoder.reset()
                    assembler.reset()
                    captures.clear()
                    generation = current
                assembler.expire(start)
                if not paused:
                    # Scalar sensor zeroing must never overwrite raw array samples.
                    payload = make_packets(frame_number, mode, start, False)
                    for offset in range(0, len(payload), 997):
                        for row in decoder.feed(payload[offset:offset + 997]):
                            raw = assembler.feed(row)
                            if raw is None:
                                continue
                            received = time.monotonic()
                            captures.append(received)
                            while captures and received - captures[0] > 1:
                                captures.popleft()
                            fps = (len(captures) - 1) / (captures[-1] - captures[0]) if len(captures) > 1 else 0
                            with self.lock:
                                if current != self.generation:
                                    continue
                                display = self.correction.apply(raw, received)
                                sequence += 1
                                captured_at = timestamp()
                                self.last_received = received
                                self.diagnostics = {
                                    'validFrames': assembler.valid_frames, 'crcErrors': decoder.crc_errors,
                                    'droppedFrames': assembler.dropped_frames, 'duplicateRows': assembler.duplicate_rows,
                                    'captureFps': round(fps, 1), 'lastFrameAt': captured_at,
                                }
                                self.latest = {
                                    'sequence': sequence, 'deviceFrame': row.frame, 'capturedAt': captured_at,
                                    'width': 64, 'height': 64, 'values': raw, 'displayValues': display,
                                    'mode': mode, 'generation': current, 'source': 'simulation',
                                    'processingVersion': self.correction.version, 'correction': self.correction.status(),
                                    'rawStatistics': statistics(raw), 'displayStatistics': statistics(display),
                                    'stats': self.diagnostics.copy(),
                                }
                    frame_number = (frame_number + 1) % 256
                self.wake.wait(max(0, start + 0.04 - time.monotonic()))
                self.wake.clear()
        except Exception as exc:
            logging.exception('模拟阵列采集异常')
            with self.lock:
                self.error = str(exc)
                self.latest = None
                self.correction.clear()

    def close(self):
        self.stopping.set()
        self.wake.set()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError('阵列采集线程未能退出')
