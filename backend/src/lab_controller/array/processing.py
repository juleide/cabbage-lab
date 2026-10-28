"""Display-only processing; never mutates acquisition samples or scalar records."""
from datetime import datetime


def timestamp():
    return datetime.now().astimezone().isoformat(timespec='milliseconds')


def statistics(values):
    maximum = max(values)
    index = values.index(maximum)
    return {'minimum': min(values), 'maximum': maximum, 'mean': sum(values) / len(values),
            'maxRow': index // 64, 'maxColumn': index % 64}


class BaselineCorrection:
    TARGET = 25
    TIMEOUT = 3.0

    def __init__(self):
        self.version = 0
        self.baseline = None
        self.sums = None
        self.count = 0
        self.deadline = 0
        self.applied_at = None
        self.error = None

    def status(self):
        return {'active': self.baseline is not None, 'collecting': self.sums is not None,
                'collected': self.count, 'target': self.TARGET, 'appliedAt': self.applied_at, 'error': self.error}

    def start(self, current):
        if self.sums is not None:
            raise ValueError('阵列零点修正正在收集中')
        self.sums = [0.0] * 4096
        self.count = 0
        self.deadline = current + self.TIMEOUT
        self.error = None

    def clear(self):
        self.baseline = self.sums = None
        self.count = 0
        self.applied_at = self.error = None
        self.version += 1

    def expire(self, current):
        if self.sums is not None and current >= self.deadline:
            self.sums = None
            self.error = '零点修正超时，未取得 25 个有效完整帧'

    def apply(self, raw, current):
        self.expire(current)
        if self.sums is not None:
            for index, value in enumerate(raw):
                self.sums[index] += value
            self.count += 1
            if self.count == self.TARGET:
                self.baseline = [value / self.TARGET for value in self.sums]
                self.sums = None
                self.applied_at = timestamp()
                self.version += 1
        return [value - self.baseline[index] for index, value in enumerate(raw)] if self.baseline is not None else raw.copy()
