"""Versioned simulation configuration; hardware connections are not implemented."""
import copy
import json
import math
import os

LIBRARIES = ('cabbage_test_2026', 'cabbage_test_archive')
DEFAULT_CONFIG = {
    'schemaVersion': 1, 'defaultPressure': 0.35, 'sampleIntervalMs': 100,
    'recordPrefix': 'EXP', 'defaultLibrary': LIBRARIES[0],
}


def validate_config(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_CONFIG):
        raise ValueError('配置字段不完整或包含未知字段')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('不支持的配置版本')
    pressure = value['defaultPressure']
    if type(pressure) not in (int, float) or not math.isfinite(pressure) or not 0 <= pressure <= 0.6:
        raise ValueError('模拟气压必须在 0～0.6 MPa 范围内')
    interval = value['sampleIntervalMs']
    if type(interval) is not int or not 100 <= interval <= 5000:
        raise ValueError('采样间隔必须是 100～5000 毫秒的整数')
    prefix = value['recordPrefix']
    if not isinstance(prefix, str) or not 1 <= len(prefix) <= 24 or not all(c.isascii() and (c.isalnum() or c in '-_') for c in prefix):
        raise ValueError('记录前缀须为 1～24 位英文字母、数字、短横线或下划线')
    if value['defaultLibrary'] not in LIBRARIES:
        raise ValueError('无效的记录库')
    return copy.deepcopy(value)


class ConfigStore:
    def __init__(self, path):
        self.path = path
        self.value = copy.deepcopy(DEFAULT_CONFIG)
        self.error = None
        if path.exists():
            try:
                self.value = validate_config(json.loads(path.read_text(encoding='utf-8')))
            except (ValueError, OSError) as exc:
                self.error = f'配置读取失败，当前使用模拟默认值：{exc}'

    def save(self, value):
        checked = validate_config(value)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        with temp.open('w', encoding='utf-8') as stream:
            json.dump(checked, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temp.replace(self.path)
        self.value = checked
        self.error = None
        return copy.deepcopy(checked)
