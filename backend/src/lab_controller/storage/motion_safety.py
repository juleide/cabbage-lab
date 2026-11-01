"""Editable safety drafts, never an authorization to actuate hardware."""
import copy
import hashlib
import json
import math
import os
import re
from datetime import date
from fractions import Fraction

TARGETS = ('motor1', 'motor2', 'lift')
COMMON_EVIDENCE = ('emergencyCircuit', 'disconnectProtection', 'mechanicalLimits')


def read_file(path):
    with path.open('rb') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('运动安全配置文件不得超过 64 KiB')
    return raw


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'运动安全配置含重复字段：{key}')
        result[key] = value
    return result


def finite_number(value):
    return ((type(value) is int and abs(value) <= 9007199254740991)
            or (type(value) is float and math.isfinite(value)))


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def hardware_version(hardware):
    return fingerprint({key: hardware[key] for key in ('motors', 'lift')})


def defaults():
    motor = dict(minimumMm=None, maximumMm=None, maxStepMm=None, maxDurationMs=None,
                 pulsesPerMm=None, direction=None, zeroPulse=None, maxSpeedRpm=None)
    return dict(schemaVersion=1, hardwareVersion='', machineId='', reviewedBy='', reviewedAt='',
                evidence=dict(emergencyCircuit='', disconnectProtection='', mechanicalLimits='',
                              motorParameters='', liftFeedback=''),
                motor1=copy.deepcopy(motor), motor2=copy.deepcopy(motor),
                lift=dict(minimumMm=None, maximumMm=None, maxStepMm=None, maxDurationMs=None,
                          feedbackMaxAgeMs=None, stopTimeoutMs=None))


def validate(value, complete=False, target=None):
    errors = []
    def shape(data, sample, path):
        if isinstance(sample, dict):
            if not isinstance(data, dict) or set(data) != set(sample):
                errors.append(f'{path}：字段不完整或包含未知字段')
                return
            for key in sample:
                shape(data[key], sample[key], f'{path}.{key}')
        elif sample is None:
            if data is not None and not finite_number(data):
                errors.append(f'{path}：必须为有限数字或 null，整数须为 JSON 安全整数，不能用布尔值代替')
        elif type(data) is not type(sample):
            errors.append(f'{path}：类型错误')
        elif isinstance(data, str) and len(data) > 512:
            errors.append(f'{path}：最多 512 个字符')
    shape(value, defaults(), '安全配置')
    if errors:
        return errors
    if value['schemaVersion'] != 1:
        return ['不支持的运动安全配置版本']
    if target is not None and target not in TARGETS:
        return ['无效的运动目标']
    if value['hardwareVersion'] and not re.fullmatch('[0-9a-f]{64}', value['hardwareVersion']):
        errors.append('hardwareVersion：应为空或 SHA-256 指纹')
    if value['reviewedAt']:
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value['reviewedAt']):
                raise ValueError()
            if date.fromisoformat(value['reviewedAt']) > date.today():
                raise ValueError()
        except ValueError:
            errors.append('reviewedAt：请填写不晚于今天的 YYYY-MM-DD 日期')
    if complete:
        for key in ('hardwareVersion', 'machineId', 'reviewedBy', 'reviewedAt'):
            if not value[key].strip():
                errors.append(f'{key}：尚未填写')
        evidence = set(COMMON_EVIDENCE)
        if target != 'lift':
            evidence.add('motorParameters')
        if target is None or target == 'lift':
            evidence.add('liftFeedback')
        for key in sorted(evidence):
            if not value['evidence'][key].strip():
                errors.append(f'evidence.{key}：尚未填写核验材料引用（引用不等于实机验收）')
    for key in TARGETS:
        if target is not None and key != target:
            continue
        axis = value[key]
        for field, number in axis.items():
            if number is None:
                if complete:
                    errors.append(f'{key}.{field}：尚未填写')
                continue
            valid = True
            if field == 'direction':
                valid = number in (-1, 1) and type(number) is int
            elif field == 'zeroPulse':
                valid = type(number) is int and 0 <= number <= 0x7FFFFFFF
            elif field.endswith('Ms'):
                # Local planning policy only, not a manufacturer timing guarantee.
                valid = type(number) is int and 1 <= number <= 60000
            elif field not in ('minimumMm', 'maximumMm'):
                valid = number > 0
            if key == 'lift' and field in ('minimumMm', 'maximumMm', 'maxStepMm'):
                valid = valid and type(number) is int and 0 <= number <= 9999
            if not valid:
                errors.append(f'{key}.{field}：数值不满足范围、整型或分辨率约束')
        low, high = axis['minimumMm'], axis['maximumMm']
        if low is not None and high is not None:
            if high <= low:
                errors.append(f'{key}：行程上限必须大于下限')
            elif axis['maxStepMm'] is not None and Fraction(str(axis['maxStepMm'])) > Fraction(str(high)) - Fraction(str(low)):
                errors.append(f'{key}.maxStepMm：单次距离不能大于配置行程')
        if (key != 'lift' and axis['pulsesPerMm'] is not None
                and type(axis['direction']) is int and axis['direction'] in (-1, 1)
                and type(axis['zeroPulse']) is int):
            for endpoint in (low, high):
                if endpoint is not None:
                    pulse = Fraction(str(endpoint)) * Fraction(str(axis['pulsesPerMm'])) * axis['direction'] + axis['zeroPulse']
                    if not 0 <= pulse <= 0x7FFFFFFF:
                        errors.append(f'{key}：标定行程超出保守非负 31 位脉冲规划区间')
                        break
    return list(dict.fromkeys(errors))


class MotionSafetyStore:
    def __init__(self, path):
        self.path = path
        self.value = defaults()
        self.error = None
        self.disk_version = None
        try:
            raw = read_file(path)
            self.disk_version = hashlib.sha256(raw).hexdigest()
            value = json.loads(raw, object_pairs_hook=unique_fields)
            errors = validate(value)
            if errors:
                raise ValueError('；'.join(errors))
            self.value = value
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            self.error = f'运动安全配置读取失败，原文件保留且运动禁用：{exc}'

    @property
    def version(self):
        return fingerprint(self.value)

    def current_error(self):
        if self.error:
            return self.error
        try:
            disk_version = hashlib.sha256(read_file(self.path)).hexdigest()
        except FileNotFoundError:
            disk_version = None
        except (OSError, ValueError) as exc:
            return f'无法读取运动安全配置文件：{exc}'
        if disk_version != self.disk_version:
            return '运动安全配置文件已被外部修改，请备份草稿并重启控制端；不会覆盖文件'
        return None

    def save(self, value, expected_version):
        error = self.current_error()
        if error:
            raise ValueError(error)
        if expected_version != self.version:
            raise ValueError('运动安全配置版本已变化，请重新载入后修改')
        errors = validate(value)
        if errors:
            raise ValueError('；'.join(errors))
        try:
            disk_version = hashlib.sha256(read_file(self.path)).hexdigest()
        except FileNotFoundError:
            disk_version = None
        if disk_version != self.disk_version:
            raise ValueError('运动安全配置文件已被外部修改，请备份草稿并重启控制端；不会覆盖文件')
        raw = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)
        self.disk_version = hashlib.sha256(raw).hexdigest()
        self.value = copy.deepcopy(value)
        return copy.deepcopy(self.value)
