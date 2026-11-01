"""Hardware configuration only. Never opens a transport or changes simulation."""
import copy
import json
import math
import os

SECTIONS = ('motors', 'lift', 'array', 'tension', 'displacement')
MOTOR_BAUDS = (9600, 19200, 38400, 115200)
MOTOR_FORMATS = ((8, 'N', 1), (8, 'N', 2), (8, 'E', 1), (8, 'O', 1))
MAX_MOTOR_RUN_MS = 3600000  # Local one-hour software bound, not a hardware guarantee.


def motor_operation():
    return dict(direction=None, speedRpm=None, maxSpeedRpm=None,
                accelerationMs=None, decelerationMs=None, maxRunMs=None)


def validate_motor_operation(value, complete=False):
    if not isinstance(value, dict) or set(value) != set(motor_operation()):
        return ['运行参数字段不完整或包含未知字段']
    errors = []
    ranges = dict(direction=(-1, 1), speedRpm=(1, 3000), maxSpeedRpm=(1, 3000),
                  accelerationMs=(1, 2000), decelerationMs=(1, 2000), maxRunMs=(1, MAX_MOTOR_RUN_MS))
    for key, (low, high) in ranges.items():
        number = value[key]
        if number is None:
            if complete:
                errors.append(f'{key}：启动前请填写')
        elif type(number) is not int or not low <= number <= high or (key == 'direction' and number not in (-1, 1)):
            errors.append(f'{key}：必须为 {low}～{high} 的整数' + ('，仅允许 -1 或 1' if key == 'direction' else ''))
    if (type(value['speedRpm']) is int and type(value['maxSpeedRpm']) is int
            and value['speedRpm'] > value['maxSpeedRpm']):
        errors.append('speedRpm：运行速度不得超过本轴安全速度上限')
    return errors


def serial(baud=None):
    return dict(port='', baud=baud, bits=8, parity='N', stop=1, timeoutMs=1000, intervalMs=100)


def defaults():
    return dict(schemaVersion=2,
                motors=dict(serial=serial(), motor1=1, motor2=2,
                            operation=dict(motor1=motor_operation(), motor2=motor_operation())),
                lift=dict(serial=serial(38400), interface='RS232'),
                array=dict(mode='usb', press=dict(rev=0, serial=serial()), grip=dict(rev=1, serial=serial())),
                tension=dict(serial=serial(9600), station=1, unit='原始值', decimals=0),
                displacement=dict(serial=serial(9600), station=1, model='', channel=1, reading='raw',
                                  rawMin=0, rawMax=5000, lower=None, upper=None, unit='mm'))


def validate(value, complete=False, section=None, *, legacy=False):
    errors = []
    template = defaults()
    if legacy:
        template['schemaVersion'] = 1
        del template['motors']['operation']

    def shape(data, sample, path):
        if isinstance(sample, dict):
            if not isinstance(data, dict) or set(data) != set(sample):
                errors.append(f'{path}：配置字段不完整或包含未知字段')
                return
            for key in sample:
                shape(data[key], sample[key], f'{path}.{key}')
        elif sample is None:
            if data is not None and (type(data) not in (int, float) or (type(data) is float and not math.isfinite(data))):
                errors.append(f'{path}：需要有效数字')
        elif type(data) is not type(sample):
            errors.append(f'{path}：类型错误')
        elif isinstance(data, str) and len(data) > 256:
            errors.append(f'{path}：内容过长')
        elif type(data) is float and not math.isfinite(data):
            errors.append(f'{path}：需要有效数字')

    shape(value, template, '设备配置')
    if errors:
        return errors
    if value['schemaVersion'] != (1 if legacy else 2):
        return ['不支持的设备配置版本']
    if section is not None and section not in SECTIONS:
        return ['无效的设备分类']

    def selected(path):
        return section is None or path.split('.')[0] == section

    def number(x, lo, hi, path, required=True, integer=True):
        if x is None:
            if complete and required and selected(path):
                errors.append(f'{path}：请填写')
        elif type(x) not in (int, float) or (integer and int(x) != x) or not lo <= x <= hi:
            errors.append(f'{path}：应为 {lo}～{hi} 的' + ('整数' if integer else '数值'))

    def choice(x, choices, path):
        if x not in choices:
            errors.append(f'{path}：选项无效')

    ports = []

    def bus(data, path, active=True):
        number(data['baud'], 1, 4000000, path + '.baud', active)
        choice(data['bits'], (5, 6, 7, 8), path + '.bits')
        choice(data['parity'], ('N', 'E', 'O'), path + '.parity')
        choice(data['stop'], (1, 2), path + '.stop')
        number(data['timeoutMs'], 50, 60000, path + '.timeoutMs')
        number(data['intervalMs'], 10, 60000, path + '.intervalMs')
        port = data['port'].strip()
        if complete and active and selected(path) and not port:
            errors.append(f'{path}.port：请填写串口')
        if active and port:
            ports.append((port.upper() if port.upper().startswith('COM') else port, path))

    for key in ('motors', 'lift', 'tension', 'displacement'):
        bus(value[key]['serial'], key + '.serial')
    motors = value['motors']
    for key in ('motor1', 'motor2'):
        number(motors[key], 1, 254 if legacy else 247, 'motors.' + key)
        if not legacy:
            errors.extend(f'motors.operation.{key}.{error}' for error in validate_motor_operation(motors['operation'][key]))
    if not legacy:
        settings = motors['serial']
        if settings['baud'] is not None and settings['baud'] not in MOTOR_BAUDS:
            errors.append('motors.serial.baud：仅支持 9600、19200、38400、115200')
        if (settings['bits'], settings['parity'], settings['stop']) not in MOTOR_FORMATS:
            errors.append('motors.serial：仅支持 8N1、8N2、8E1、8O1')
    if motors['motor1'] is not None and motors['motor1'] == motors['motor2']:
        errors.append('motors：两个电机站号不能重复')
    choice(value['lift']['interface'], ('RS232', 'RS485'), 'lift.interface')
    array = value['array']
    choice(array['mode'], ('usb', 'serial'), 'array.mode')
    for key in ('press', 'grip'):
        number(array[key]['rev'], 0, 3, 'array.' + key + '.rev')
        bus(array[key]['serial'], 'array.' + key + '.serial', array['mode'] == 'serial')
    if array['mode'] == 'usb' and array['press']['rev'] == array['grip']['rev']:
        errors.append('array：按压与抓取 REV 号不能重复')
    for key in ('tension', 'displacement'):
        number(value[key]['station'], 1, 247, key + '.station')
        if not value[key]['unit'].strip():
            errors.append(key + '.unit：请填写结果单位')
    number(value['tension']['decimals'], 0, 9, 'tension.decimals')
    d = value['displacement']
    choice(d['model'], ('', 'p', 'g'), 'displacement.model')
    if complete and selected('displacement') and not d['model']:
        errors.append('displacement.model：请选择模块类型')
    number(d['channel'], 1, 3, 'displacement.channel')
    choice(d['reading'], ('raw', 'float'), 'displacement.reading')
    if d['model'] == 'p' and (d['channel'] != 1 or d['rawMin'] != 0 or d['rawMax'] != 5000):
        errors.append('displacement：P 型固定 CH1，原始值范围为 0～5000')
    for key in ('rawMin', 'rawMax', 'lower', 'upper'):
        number(d[key], -1e12, 1e12, 'displacement.' + key, d['reading'] == 'raw', False)
    if d['reading'] == 'raw':
        for lo, hi in (('rawMin', 'rawMax'), ('lower', 'upper')):
            if d[lo] is not None and d[hi] is not None and d[hi] <= d[lo]:
                errors.append(f'displacement.{hi}：上限必须大于下限')
    for i, (port, path) in enumerate(ports):
        for other, other_path in ports[:i]:
            if port == other and (selected(path) or selected(other_path)):
                errors.append(f'{path}.port：{port} 已用于 {other_path}')
    # In section checks, unrelated incomplete or invalid sections do not block verification.
    if section is not None:
        errors = [e for e in errors if e.startswith(section + '.') or e.startswith(section + '：') or ('已用于' in e and section in e)]
    return list(dict.fromkeys(errors))


class HardwareStore:
    def __init__(self, path):
        self.path = path
        self.value = defaults()
        self.error = None
        self.warnings = []
        if path.exists():
            try:
                value = json.loads(path.read_text(encoding='utf-8'))
                legacy = isinstance(value, dict) and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1
                errors = validate(value, legacy=legacy)
                if errors:
                    raise ValueError('；'.join(errors))
                if legacy:
                    value = copy.deepcopy(value)
                    value['schemaVersion'] = 2
                    value['motors']['operation'] = dict(motor1=motor_operation(), motor2=motor_operation())
                    self.warnings = ['已在内存中迁移旧配置；运行参数留空，原文件未改写。显式保存后写入 v2。'] + validate(value)
                self.value = value
            except (ValueError, OSError) as exc:
                self.error = f'设备配置读取失败，原文件未修改：{exc}'

    def save(self, value):
        if self.error:
            raise ValueError(self.error + '。请先备份并修复或移走损坏文件后重启控制端')
        errors = validate(value)
        if errors:
            raise ValueError('；'.join(errors))
        checked = copy.deepcopy(value)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix('.tmp')
        with temp.open('w', encoding='utf-8') as stream:
            json.dump(checked, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temp.replace(self.path)
        self.value = checked
        self.warnings = []
        return copy.deepcopy(checked)
