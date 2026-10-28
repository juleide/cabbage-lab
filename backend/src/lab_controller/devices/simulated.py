"""Simulation-only device adapter. No serial/TCP connection is opened."""
import math

DEVICE_NAMES = {'motor1': '1 号电机', 'motor2': '2 号电机', 'lift': '升降装置'}


def measurements(tick, zero, running, pressure):
    time = tick * 0.1
    noise = math.sin(time * 3.2) * 0.12 + math.cos(time * 1.7) * 0.09
    normal = 0 if zero else 24.68 + math.sin(time * 0.65) * 0.65 + noise
    friction = 0 if zero else 8.42 + math.sin(time * 0.65) * 0.28 + noise * 0.4
    return {
        'normal': normal, 'area': 0 if zero else 32.5 + math.sin(time * 0.35) * 0.21,
        'friction': friction, 'speed': 10 + noise * 0.1 if running else 0,
        'coefficient': friction / normal if normal else 0, 'pressure': pressure,
    }


class SimulatedDevice:
    def __init__(self):
        self.outputs = dict.fromkeys(DEVICE_NAMES, False)

    def set_output(self, name, enabled):
        self.outputs[name] = enabled

    def stop(self):
        self.outputs = dict.fromkeys(DEVICE_NAMES, False)

    def read(self, tick, zero, running, pressure):
        return measurements(tick, zero, running, pressure)
