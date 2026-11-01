"""Conservative readiness of the fixed machine, never an authorization to move."""
REQUIRED = ('motors', 'lift', 'tension', 'displacement', 'arrayPress', 'arrayGrip')


def assess(motion, sensors, *, config_error=None, connection_errors=None):
    errors = connection_errors or {}
    devices = {}
    for section in REQUIRED:
        item = dict(required=True, state='unavailable', reason=errors.get(section, '等待有效真实反馈'))
        status = motion.get(section) if section in ('motors', 'lift') else sensors.get(section)
        if section in ('arrayPress', 'arrayGrip'):
            item['reason'] = '真实电子皮肤驱动尚未接入'
        elif section == 'lift':
            item['reason'] = '升降位置反馈不能确认待机，运行/停止判据尚未核验'
            if status and status.get('state') == 'failed':
                item.update(state='fault', reason=status.get('error') or '升降通信失败')
            elif status and status.get('state') == 'connecting':
                item.update(state='connecting', reason='升降连接中，待机判据尚未核验')
        elif status:
            phase = status.get('state')
            if phase == 'connecting':
                item.update(state='connecting', reason='设备连接中')
            elif phase == 'failed' or status.get('faultLatched'):
                item.update(state='fault', reason=status.get('error') or '设备会话故障')
            elif section == 'motors' and phase == 'monitoring':
                readings = [status.get('readings', {}).get(key, {}) for key in ('motor1', 'motor2')]
                if any(reading.get('fault') for reading in readings):
                    item.update(state='fault', reason='电机故障反馈')
                elif any(reading.get('quality') == 'stale' or reading.get('speed', {}).get('quality') == 'stale'
                         for reading in readings):
                    item.update(state='fault', reason='电机状态或速度反馈过期')
                elif all(reading.get('quality') == 'valid' and reading.get('speed', {}).get('quality') == 'valid'
                         and reading.get('running') is False and reading.get('speed', {}).get('rpm') == 0
                         and reading.get('enabled') is True and not reading.get('positiveLimit')
                         and not reading.get('negativeLimit') for reading in readings):
                    item.update(state='ready', reason='两台电机新鲜反馈为已使能且静止；非机械安全证明')
                else:
                    item['reason'] = '等待两台电机有效待机状态和速度反馈'
            elif section in ('tension', 'displacement'):
                if phase == 'collecting' and status.get('quality') == 'valid' and status.get('reading') is not None:
                    item.update(state='ready', reason='已收到有效真实反馈；工程量映射另行核验')
                elif status.get('quality') in ('stale', 'invalid'):
                    item.update(state='fault', reason='传感器反馈过期或无效')
        devices[section] = item
    if config_error:
        state = 'fault'
    elif any(item['state'] == 'fault' for item in devices.values()):
        state = 'fault'
    elif all(item['state'] == 'ready' for item in devices.values()):
        state = 'ready'
    elif any(item['state'] == 'connecting' for item in devices.values()):
        state = 'connecting'
    else:
        state = 'unavailable'
    return dict(state=state, devices=devices, configError=config_error,
                missing=[key for key, item in devices.items() if item['state'] != 'ready'])
