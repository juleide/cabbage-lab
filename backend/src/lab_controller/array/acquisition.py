import logging
import threading
import time
from .processing import BaselineCorrection


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
        self.thread = threading.Thread(target=self.run, daemon=True, name='array-awaiting-hardware')
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
        # No array transport driver is integrated yet; never synthesize frames.
        while not self.stopping.is_set():
            self.wake.wait(0.25)
            self.wake.clear()

    def close(self):
        self.stopping.set()
        self.wake.set()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError('阵列采集线程未能退出')
