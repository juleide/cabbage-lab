"""Real measurement snapshots: missing, invalid and expired inputs are zero.

Only device adapters supply normalized readings. There is no simulator,
last-value fallback or externally writable measurement RPC.
"""
import math
import time

UNITS = dict(normal='N', friction='N', area='cm2', speed='mm/s', pressure='MPa',
             gripArea='cm2', gripForce='N')


class RealReadings:
    def __init__(self, stale_after_ms=1000, clock=time.monotonic):
        if type(stale_after_ms) is not int or stale_after_ms <= 0:
            raise ValueError('读数有效期必须为正整数毫秒')
        self.stale_after_ms = stale_after_ms
        self.clock = clock
        self.readings = {}

    def update(self, name, value, *, source, unit, received=None):
        if name not in UNITS:
            raise ValueError('未知的真实测量项')
        current = self.clock()
        received = current if received is None else received
        if (type(received) not in (int, float) or not math.isfinite(received) or received > current
                or type(value) not in (int, float) or not math.isfinite(value)
                or not isinstance(source, str) or not source.strip() or unit != UNITS[name]):
            self.readings.pop(name, None)
            raise ValueError('真实读数必须包含有限数值、设备来源和匹配单位')
        previous = self.readings.get(name)
        if previous and previous['source'] == source and received <= previous['received']:
            return
        self.readings[name] = dict(value=value, source=source, received=received)

    def invalidate_source(self, source):
        self.readings = {name: reading for name, reading in self.readings.items() if reading['source'] != source}

    def snapshot(self):
        now = self.clock()
        values, quality = {}, {}
        for name, unit in UNITS.items():
            reading = self.readings.get(name)
            age = max(0, (now - reading['received']) * 1000) if reading else None
            valid = reading is not None and age <= self.stale_after_ms
            values[name] = reading['value'] if valid else 0
            quality[name] = dict(valid=valid, source=reading['source'] if reading else None,
                                 unit=unit, ageMs=age, state='valid' if valid else 'stale' if reading else 'unavailable')
        # Dimensionless coefficient is available only while both real forces
        # are fresh and the normal force can be used as a denominator.
        valid = quality['normal']['valid'] and quality['friction']['valid'] and values['normal'] > 0
        coefficient = values['friction'] / values['normal'] if valid else 0
        valid = valid and math.isfinite(coefficient)
        values['coefficient'] = coefficient if valid else 0
        quality['coefficient'] = dict(valid=valid, source='derived:friction/normal' if valid else None,
                                      unit='1', state='valid' if valid else 'unavailable')
        return dict(values=values, quality=quality)
