"""Fail-closed capability assessment and offline planning. No serial access."""
from fractions import Fraction

from ..storage.hardware import validate as validate_hardware
from ..storage.motion_safety import TARGETS, finite_number, hardware_version, validate


def assess(store, hardware, sessions, hardware_error=None, stopped=False):
    binding = hardware_version(hardware)
    store_error = store.current_error()
    targets = {}
    for target in TARGETS:
        section = 'lift' if target == 'lift' else 'motors'
        errors = validate(store.value, complete=True, target=target)
        errors += validate_hardware(hardware, complete=True, section=section)
        if store_error:
            errors.append(store_error)
        if hardware_error:
            errors.append(hardware_error)
        if store.value['hardwareVersion'] != binding:
            errors.append('安全草稿未绑定当前电机/升降连接配置，或连接配置已变化')
        if section == 'motors' and (any(hardware['motors'][key] is None or not 1 <= hardware['motors'][key] <= 247
                for key in ('motor1', 'motor2')) or hardware['motors']['serial']['baud'] not in (9600, 19200, 38400, 115200)):
            errors.append('电机站号或波特率不在当前驱动支持范围')
        if section == 'lift' and (hardware['lift']['interface'] != 'RS232' or any(
                hardware['lift']['serial'][key] != value for key, value in dict(baud=38400, bits=8, parity='N', stop=1).items())):
            errors.append('升降当前仅支持 RS232 38400/8N1')
        reasons = [dict(code='PROFILE_INCOMPLETE', message=error) for error in errors]
        reasons.extend([
            dict(code='EXECUTION_NOT_IMPLEMENTED', message='真实启动/定位/回零执行链路尚未开放；完整草稿也不能授权运动'),
            dict(code='EVIDENCE_NOT_VERIFIED', message='材料引用仅为人工记录，程序未核验原始材料和现场安全验收'),
            dict(code='IDENTITY_NOT_VERIFIED', message='连接配置指纹不是设备身份核验，不证明现场设备与标定一致'),
            dict(code='PROTOCOL_UNCONFIRMED', message='升降停止标志、断线制动与反馈周期待确认' if section == 'lift'
                 else '电机速度/加减速/回零参数逐寄存器映射及机械验收待确认'),
        ])
        session = sessions.get(section)
        reading = session.get('readings', {}).get(target) if session else None
        if not session or session['state'] != 'monitoring':
            reasons.append(dict(code='NOT_CONNECTED', message='没有活动诊断连接'))
        if session and session['faultLatched']:
            reasons.append(dict(code='FAULT_LATCHED', message='诊断会话存在故障/软件急停锁存'))
        if not reading or reading['quality'] != 'valid':
            reasons.append(dict(code='FEEDBACK_UNAVAILABLE', message='没有新鲜有效的目标反馈'))
        if section == 'motors':
            reasons.append(dict(code='POSITION_UNAVAILABLE', message='当前电机诊断未采集可用于运动许可的位置反馈'))
            if reading and (reading.get('fault') or reading.get('positiveLimit') or reading.get('negativeLimit') or reading.get('running')):
                reasons.append(dict(code='DEVICE_NOT_IDLE', message='目标反馈存在故障、软限位或运行位'))
        else:
            reasons.append(dict(code='POSITION_UNIT_UNVERIFIED', message='升降高度单位尚未实机核验，不作为运动许可位置'))
        if stopped:
            reasons.append(dict(code='SOFTWARE_EMERGENCY', message='主试验台处于软件急停锁定状态'))
        targets[target] = dict(canPreview=not errors, canExecute=False, reasons=reasons)
    return dict(configVersion=store.version, hardwareVersion=binding,
                bindingMatches=store.value['hardwareVersion'] == binding,
                evidenceVerified=False, error=store_error, targets=targets)


def preview(store, hardware, assessment, params):
    target = params.get('target')
    if target not in TARGETS:
        raise ValueError('请选择 motor1、motor2 或 lift')
    expected = {'target', 'fromMm', 'positionMm', 'durationMs', 'expectedVersion', 'expectedHardwareVersion'}
    if target != 'lift':
        expected.add('speedRpm')
    if set(params) != expected:
        raise ValueError('离线规划参数不完整或包含未知字段')
    if params['expectedVersion'] != store.version or params['expectedHardwareVersion'] != hardware_version(hardware):
        raise ValueError('安全或连接配置版本已变化，请重新载入后规划')
    if not assessment['targets'][target]['canPreview']:
        raise ValueError('安全草稿或连接配置不完整/不匹配，不能进行离线规划')
    axis = store.value[target]
    for field in ('fromMm', 'positionMm', 'durationMs') + (() if target == 'lift' else ('speedRpm',)):
        number = params[field]
        if not finite_number(number):
            raise ValueError('规划参数必须是有限数值，不能使用布尔值')
    start, end = (Fraction(str(params[key])) for key in ('fromMm', 'positionMm'))
    if not all(Fraction(str(axis['minimumMm'])) <= point <= Fraction(str(axis['maximumMm'])) for point in (start, end)):
        raise ValueError('起点或目标超出安全草稿行程')
    if not 0 < abs(end - start) <= Fraction(str(axis['maxStepMm'])):
        raise ValueError('目标距离为零或超过单次距离上限')
    if type(params['durationMs']) is not int or not 1 <= params['durationMs'] <= axis['maxDurationMs']:
        raise ValueError('规划时长必须为正整数且不超过草稿上限；时长不是预计到位时间')
    result = dict(mode='offline', executable=False, target=target, fromMm=params['fromMm'],
                  positionMm=params['positionMm'], durationMs=params['durationMs'],
                  configVersion=store.version, hardwareVersion=hardware_version(hardware),
                  message='仅为人工输入起点的离线计算，不读取实际位置、不发送报文、不产生运动许可')
    if target == 'lift':
        if start.denominator != 1 or end.denominator != 1:
            raise ValueError('升降仅接受整数 mm，不静默舍入小于 1 mm 的目标')
        result['positionAsciiCm'] = f'{int(end) // 10:03d}.{int(end) % 10}'
    else:
        if not 0 < params['speedRpm'] <= axis['maxSpeedRpm']:
            raise ValueError('规划速度必须为正数且不超过草稿上限')
        pulses = [point * Fraction(str(axis['pulsesPerMm'])) * axis['direction'] + axis['zeroPulse'] for point in (start, end)]
        if any(point.denominator != 1 or not 0 <= point <= 0x7FFFFFFF for point in pulses):
            raise ValueError('标定结果必须为保守非负 31 位整数脉冲，不静默舍入')
        pulse = int(pulses[1])
        result.update(fromPulse=int(pulses[0]), targetPulse=pulse, highWord=pulse >> 16,
                      lowWord=pulse & 0xFFFF, speedRpm=params['speedRpm'])
    return result
