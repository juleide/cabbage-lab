import copy
import logging
import json
import time
from datetime import datetime
from ..array.acquisition import ArrayAcquisition
from ..devices.readings import RealReadings
from ..devices.readiness import assess as assess_readiness
from ..devices.ports import list_ports
from ..devices.verification import VerificationManager, SUPPORTED
from ..devices.sensors import SensorManager, port_key, SECTIONS as SENSOR_SECTIONS
from ..devices.motion import MotionManager, SECTIONS as MOTION_SECTIONS
from ..storage.config import ConfigStore, LIBRARIES
from ..storage.records import RecordStore
from ..storage.hardware import HardwareStore, validate as validate_hardware
from ..storage.motion_safety import MotionSafetyStore, hardware_version
from ..devices.motion_safety import assess as assess_safety, preview as preview_motion


def now():
    return datetime.now().astimezone().isoformat(timespec='milliseconds')


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Controller:
    def __init__(self, root, emit):
        self.emit = emit
        self.config = ConfigStore(root / 'config' / 'controller.json')
        self.hardware = HardwareStore(root / 'config' / 'hardware.json')
        self.safety = MotionSafetyStore(root / 'config' / 'motion-safety.json')
        self.verification = VerificationManager()
        self.sensors = SensorManager()
        self.motion = MotionManager()
        self.connection_errors = {}
        self.pending_connections = {}
        self.motion_finished = {}
        self.sensor_finished = {}
        self.sensor_sequences = {}
        self.records = RecordStore(root / 'data' / 'experiments.sqlite3')
        self.readings = RealReadings()
        self.state = {
            'devices': dict.fromkeys(('motor1', 'motor2', 'lift'), False), 'initialized': False, 'running': False,
            'stopped': False, 'zero': False, 'pressure': 0,
            'tick': 0, 'values': {}, 'database': self.config.value['defaultLibrary'],
            'runId': None, 'sampleCount': 0,
        }
        self.select_library(self.state['database'])
        self.array = ArrayAcquisition()
        self.last_array_sequence = -1
        self.next_array_publish = 0.0
        self.refresh()
        self.log('Python 控制端已启动 · 真实硬件待连接，不会自动启动执行机构')
        if self.config.error:
            self.log(self.config.error)
        self.auto_connect_configured()

    def connection_config(self, section):
        require(not self.hardware.error, self.hardware.error or '')
        errors = validate_hardware(self.hardware.value, complete=True, section=section, connection_only=True)
        require(not errors, '；'.join(errors))
        return copy.deepcopy(self.hardware.value[section])

    def require_port_available(self, section, config):
        requested = port_key(config['serial']['port'])
        for manager in (self.motion, self.sensors):
            for other, session in manager.sessions.items():
                require(not session.thread.is_alive() or (other != section and
                        port_key(session.config['serial']['port']) != requested),
                        f'{section} 设备会话或串口已被 {other} 占用，请先断开并等待释放')
        if self.verification.active():
            probe = self.verification.snapshot()
            require(probe.get('section') != section and port_key(probe.get('port', '')) != requested,
                    '该设备串口正在只读验证，请等待或取消验证并等待端口释放')

    def connect_sensor(self, section):
        self.unlocked()
        require(section not in self.pending_connections, '该设备正在应用配置，请等待或先断开取消')
        config = self.connection_config(section)
        self.require_port_available(section, config)
        self.poll_hardware()
        session = self.sensors.connect(section, config)
        self.sensor_sequences[section] = 0
        stored = False
        try:
            self.records.begin_sensor(session.snapshot(), config)
            stored = True
            session.thread.start()
        except Exception as exc:
            session.disconnect()
            self.sensors.sessions.pop(section, None)
            if stored:
                failed = session.snapshot()
                failed.update(state='failed', finishedAt=time.time(), error=f'启动采集线程失败：{exc}')
                self.records.finish_sensor(failed)
            raise
        self.log(f'{section} 真实只读采集会话已创建；未确认的首页工程量保持 0')
        self.connection_errors.pop(section, None)
        return session

    def connect_motion(self, section, *, control=False):
        self.unlocked()
        require(section not in self.pending_connections, '该设备正在应用配置，请等待或先断开取消')
        config = self.connection_config(section)
        self.require_port_available(section, config)
        self.poll_hardware()
        self.log(f'{section} 真实连接请求，配置快照：' + json.dumps(config, ensure_ascii=False, sort_keys=True))
        session = self.motion.connect(section, config, control=control)
        self.log(f"{section} 会话 {session.status['sessionId']} 已创建；连接不启动、不使能，机械停止须现场确认")
        self.connection_errors.pop(section, None)
        return session

    def auto_connect_configured(self):
        """The controller thread creates sessions; their workers own device I/O."""
        for section in ('tension', 'displacement', 'motors', 'lift'):
            try:
                if section in SENSOR_SECTIONS:
                    self.connect_sensor(section)
                else:
                    self.connect_motion(section, control=section == 'motors')
            except Exception as exc:
                self.connection_errors[section] = str(exc)
                self.log(f'{section} 自动连接失败：{exc}')

    def apply_pending_connections(self):
        """Run on the IPC thread only, after queued operator requests are drained."""
        for section, pending in list(self.pending_connections.items()):
            if self.state['stopped']:
                self.pending_connections.pop(section, None)
                continue
            session = pending['session']
            if session.thread.is_alive():
                if time.monotonic() >= pending['deadline']:
                    self.pending_connections.pop(section, None)
                    self.connection_errors[section] = '旧连接未及时释放，已取消配置重连；请现场确认后手动连接'
                    self.log(f'{section}：' + self.connection_errors[section])
                continue
            self.pending_connections.pop(section, None)
            if session.status.get('state') == 'failed' or session.status.get('error') or session.status.get('faultLatched'):
                self.connection_errors[section] = '旧连接关闭时存在故障或停止结果未知，已取消配置重连；请现场确认后手动连接'
                self.log(f'{section}：' + self.connection_errors[section])
                continue
            if any(item['session'].thread.is_alive() for item in self.pending_connections.values()):
                self.pending_connections[section] = pending
                continue
            try:
                if section in SENSOR_SECTIONS:
                    self.connect_sensor(section)
                else:
                    self.connect_motion(section, control=pending['control'])
                self.log(f'{section} 新配置已创建只读连接；不恢复先前运动')
            except Exception as exc:
                self.connection_errors[section] = str(exc)
                self.log(f'{section} 配置重连失败，不自动重试：{exc}')

    def refresh(self):
        self.array.configure(paused=self.state['stopped'])
        self.state['array'] = self.array.status()
        self.state['devices'] = dict.fromkeys(('motor1', 'motor2', 'lift'), False)
        feedback = {target: dict(state='unknown', quality='unavailable', physicalStopConfirmed=False)
                    for target in self.state['devices']}
        session = self.motion.sessions.get('motors')
        self.state['motorControl'] = None
        if session:
            status = session.snapshot()
            if status.get('purpose') == 'control':
                self.state['motorControl'] = dict(sessionId=status['sessionId'], configVersion=status['configVersion'],
                                                   state=status['state'], axes=status.get('axes', {}))
            for target in ('motor1', 'motor2'):
                reading = status['readings'].get(target)
                if not reading:
                    continue
                valid = status['state'] == 'monitoring' and reading.get('quality') == 'valid'
                if valid and type(reading.get('running')) is bool:
                    self.state['devices'][target] = reading['running']
                    feedback[target].update(state='running' if reading['running'] else 'stopped', quality='valid')
                else:
                    feedback[target]['quality'] = 'stale'
        self.state['deviceFeedback'] = feedback
        measurements = self.readings.snapshot()
        self.state['values'] = measurements['values']
        self.state['measurementQuality'] = measurements['quality']
        self.state['readiness'] = assess_readiness(self.motion.snapshot(), self.sensors.snapshot(),
                                                  config_error=self.hardware.error,
                                                  connection_errors=self.connection_errors)

    def snapshot(self):
        self.refresh()
        return {'state': copy.deepcopy(self.state), 'config': copy.deepcopy(self.config.value),
                'configError': self.config.error, 'logs': self.records.logs(),
                'pressureFrame': self.array.snapshot()}

    def publish(self):
        self.refresh()
        self.emit('state', self.state)

    def log(self, message):
        entry = {'time': now(), 'message': message}
        self.records.log(entry['time'], message)
        logging.info(message)
        self.emit('log', entry)

    def idle(self):
        require(not self.state['running'] and not any(self.state['devices'].values()), '请先停止试验和全部执行机构')

    def unlocked(self):
        require(not self.state['stopped'], '设备已急停，请先确认安全并解除急停')

    def select_library(self, library):
        self.state['database'] = library
        runs = self.records.list(library)
        self.state['runId'] = runs[0]['id'] if runs else None
        self.state['sampleCount'] = runs[0]['sampleCount'] if runs else 0

    def stop(self, reason, emergency=False):
        self.pending_connections.clear()
        self.motion.stop(emergency=emergency, close=True)
        self.verification.cancel()
        self.sensors.disconnect()
        if self.state['running']:
            self.records.finish(self.state['runId'], now(), 'emergency' if emergency else 'stopped')
        self.state['running'] = False
        if emergency:
            self.state['stopped'] = True
        self.log(reason)
        self.publish()

    def publish_array(self):
        self.poll_hardware()
        current = time.monotonic()
        if current < self.next_array_publish:
            return
        self.next_array_publish = current + 0.1
        frame = self.array.snapshot()
        status = self.array.status()
        if self.state['array'] != status:
            self.state['array'] = status
            self.emit('state', self.state)
        if frame and frame['sequence'] != self.last_array_sequence:
            self.last_array_sequence = frame['sequence']
            self.emit('pressure.frame', frame)

    def tick(self):
        if not self.state['stopped']:
            self.state['tick'] += self.config.value['sampleIntervalMs'] / 100
        self.refresh()
        if self.state['running']:
            missing = [name for name, quality in self.state['measurementQuality'].items() if not quality['valid']]
            if missing:
                self.stop('必要真实读数失效，试验记录已结束，不写入占位零：' + '、'.join(missing))
                return
            number = self.state['sampleCount'] + 1
            self.records.append(self.state['runId'], number, now(), self.state['values'])
            self.state['sampleCount'] = number
        self.emit('state', self.state)

    def command(self, command):
        require(isinstance(command, dict) and isinstance(command.get('type'), str), '无效的控制命令')
        kind = command['type']
        expected = {'motor': {'type', 'device', 'enabled', 'sessionId', 'configVersion'},
                    'toggle': {'type', 'device'}, 'pressure': {'type', 'value'}, 'database': {'type', 'value'}}
        require(set(command) == expected.get(kind, {'type'}), '控制命令参数错误')
        if kind == 'motor':
            require(type(command['device']) is str and command['device'] in ('motor1', 'motor2')
                    and type(command['enabled']) is bool, '仅允许两个固定电机的明确启停请求')
            if not command['enabled']:
                self.pending_connections.pop('motors', None)
            session = self.motion.sessions.get('motors')
            require(session is not None and session.status.get('purpose') == 'control'
                    and session.thread.is_alive(), '没有活动的真实电机控制连接')
            if command['enabled']:
                self.unlocked()
                require(not self.state['running'], '联动试验期间不能独立启动电机')
                require(type(command['sessionId']) is str and type(command['configVersion']) is str,
                        '启动必须绑定会话和配置版本')
                session.start(command['device'], command['sessionId'], command['configVersion'])
            else:
                session.stop(target=command['device'], emergency=False)
            self.publish()
            return {'message': '已请求电机启动，等待真实反馈' if command['enabled'] else '已请求电机停止，机械停止须现场确认'}
        if kind in ('emergency', 'stop'):
            emergency = kind == 'emergency'
            self.stop('软件急停：请求停止并断开真实设备' if emergency else '请求停止并断开真实设备', emergency=emergency)
            return {'message': '已请求真实设备停止；机械停止结果须现场确认'}
        if kind == 'database':
            require(not self.state['running'], '请先结束试验再切换记录库')
            require(isinstance(command['value'], str) and command['value'] in LIBRARIES, '无效的记录库')
            self.select_library(command['value'])
            message = '已切换记录库'
        elif kind == 'reset':
            require(self.state['stopped'], '当前未处于急停状态')
            require(not self.motion.active(), '请等待执行机构停止及断开结束，并现场确认机械安全')
            self.state['stopped'] = False
            message = '软件急停已解除；不清除驱动器故障、不置零、不重连或恢复运动'
        else:
            self.unlocked()
            unsupported = {
                'toggle': '该首页开关尚未接入真实控制；不接受模拟启停',
                'pressure': '气压设定尚未接入真实硬件',
                'commitPressure': '气压设定尚未接入真实硬件',
                'initialize': '真实硬件初始化流程尚未实现',
                'home': '真实回零驱动尚未实现',
                'zero': '请在设备连接页执行已支持的传感器软件相对置零',
                'run': '真实联动试验采集尚未接入，不能创建占位记录',
            }
            raise ValueError(unsupported.get(kind, '不支持的控制命令'))
        self.log(message)
        self.publish()
        return {'message': message}

    def request(self, method, params):
        require(isinstance(params, dict), '请求参数必须是对象')
        self.poll_hardware()
        self.refresh()
        if method in ('hardware.safety.get', 'hardware.safety.status'):
            require(not params, '该请求不接受参数')
            assessment = self.safety_assessment()
            return {'config': copy.deepcopy(self.safety.value), 'assessment': assessment} if method.endswith('.get') else assessment
        if method == 'hardware.safety.save':
            require(set(params) == {'config', 'expectedVersion', 'expectedHardwareVersion'}, '安全配置保存参数错误')
            self.idle()
            require(not self.motion.active() and not self.sensors.active() and not self.verification.active(), '请先结束真实设备诊断、采集及验证，再保存安全草稿')
            require(not self.hardware.error, self.hardware.error or '')
            require(params['expectedHardwareVersion'] == hardware_version(self.hardware.value), '设备连接配置已变化，请刷新评估并显式重新绑定草稿')
            self.safety.save(params['config'], params['expectedVersion'])
            self.log(f'运动安全草稿已保存 {self.safety.version}，仅为配置记录，不产生运动许可')
            return {'config': copy.deepcopy(self.safety.value), 'assessment': self.safety_assessment()}
        if method == 'hardware.safety.preview':
            result = preview_motion(self.safety, self.hardware.value, self.safety_assessment(), params)
            self.log('运动离线规划（不执行）：' + json.dumps(result, ensure_ascii=False, sort_keys=True))
            return result
        if method == 'hardware.motor.status':
            require(not params, '该请求不接受参数')
            session = self.motion.sessions.get('motors')
            return session.snapshot() if session and session.status.get('purpose') == 'control' else None
        if method == 'hardware.motor.connect':
            require(not params, '电机连接不接受参数，使用已保存配置')
            return self.connect_motion('motors', control=True).snapshot()
        if method in ('hardware.motor.start', 'hardware.motor.stop', 'hardware.motor.disconnect'):
            if not method.endswith('.start'):
                self.pending_connections.pop('motors', None)
            expected = {'target', 'sessionId', 'configVersion'} if method.endswith('.start') else (
                {'target', 'emergency'} if method.endswith('.stop') else set())
            require(set(params) == expected, '电机控制参数错误')
            session = self.motion.sessions.get('motors')
            require(session is not None and session.status.get('purpose') == 'control' and session.thread.is_alive(),
                    '没有活动的真实电机控制连接')
            if method.endswith('.start'):
                require(not self.state['running'], '联动试验期间不能独立启动电机')
                self.unlocked()
                require(type(params['target']) is str and params['target'] in ('motor1', 'motor2'), '无效的电机目标')
                require(type(params['sessionId']) is str and type(params['configVersion']) is str, '会话及配置版本必须为字符串')
                session.start(params['target'], params['sessionId'], params['configVersion'])
            elif method.endswith('.stop'):
                require(params['target'] is None or (type(params['target']) is str and params['target'] in ('motor1', 'motor2')),
                        '无效的电机停止目标')
                require(type(params['emergency']) is bool, '急停参数必须为布尔值')
                require(not params['emergency'] or params['target'] is None, '全局软件急停必须覆盖两个电机')
                session.stop(target=params['target'], emergency=params['emergency'])
            else:
                session.stop(close=True)
            return session.snapshot()
        if method == 'hardware.motion.status':
            require(not params, '该请求不接受参数')
            return self.motion.snapshot()
        if method == 'hardware.motion.connect':
            require(set(params) == {'section'} and params['section'] in MOTION_SECTIONS, '请选择电机或升降')
            self.connect_motion(params['section'])
            return self.motion.snapshot()
        if method in ('hardware.motion.stop', 'hardware.motion.disconnect'):
            expected = {'section', 'emergency'} if method.endswith('.stop') else {'section'}
            require(set(params) == expected and params.get('section') in MOTION_SECTIONS, '执行机构停止参数错误')
            require(method.endswith('.disconnect') or type(params['emergency']) is bool, '急停参数必须为布尔值')
            self.pending_connections.pop(params['section'], None)
            session = self.motion.sessions.get(params['section'])
            require(session is not None and session.thread.is_alive(), '该执行机构没有活动诊断连接')
            self.motion.stop(params['section'], emergency=params.get('emergency', False), close=method.endswith('.disconnect'))
            return self.motion.snapshot()
        if method == 'system.motion.lock':
            require(not params, '该请求不接受参数')
            for section in MOTION_SECTIONS:
                self.pending_connections.pop(section, None)
            self.motion.stop(emergency=True, close=True)
            return None
        if method == 'hardware.sensors.status':
            require(not params, '该请求不接受参数')
            return self.sensors.snapshot()
        if method == 'hardware.sensors.connect':
            require(set(params) == {'section'} and params['section'] in SENSOR_SECTIONS, '请选择拉力或位移传感器')
            self.connect_sensor(params['section'])
            return self.sensors.snapshot()
        if method == 'hardware.sensors.disconnect':
            require(set(params) == {'section'} and params['section'] in SENSOR_SECTIONS, '请选择拉力或位移传感器')
            self.pending_connections.pop(params['section'], None)
            self.sensors.disconnect(params['section'])
            return self.sensors.snapshot()
        if method == 'hardware.sensors.zero':
            require(params == {'section': 'displacement'}, '仅支持位移软件相对置零')
            session = self.sensors.sessions.get('displacement')
            require(session is not None, '位移传感器尚未连接')
            session.zero()
            return self.sensors.snapshot()
        if method == 'hardware.sensors.records.list':
            require(not params, '该请求不接受参数')
            return self.records.sensor_runs()
        if method == 'hardware.sensors.records.read':
            require(set(params) == {'sessionId', 'offset', 'limit'}, '采集记录分页参数错误')
            require(isinstance(params['sessionId'], str) and len(params['sessionId']) <= 100, '无效的采集编号')
            require(type(params['offset']) is int and params['offset'] >= 0, '无效的分页偏移')
            require(type(params['limit']) is int and 1 <= params['limit'] <= 100, '单页最多读取 100 条记录')
            return self.records.read_sensor(params['sessionId'], params['offset'], params['limit'])
        if method == 'hardware.ports.list':
            require(not params, '该请求不接受参数')
            return list_ports()
        if method == 'hardware.status':
            require(not params, '该请求不接受参数')
            return self.verification.snapshot()
        if method == 'hardware.verify.cancel':
            require(not params, '该请求不接受参数')
            return self.verification.cancel()
        if method == 'hardware.verify':
            require(set(params) == {'section'} and params['section'] in SUPPORTED,
                    '请选择电机、拉力或位移分类进行只读验证；升降及电子皮肤尚不支持')
            section = params['section']
            config = self.connection_config(section)
            self.require_port_available(section, config)
            stations = [config['motor1'], config['motor2']] if section == 'motors' else [config['station']]
            require(all(1 <= station <= 247 for station in stations), '只读验证仅支持站号 1～247，不使用特殊地址探测')
            return self.verification.start(section, config)
        if method == 'state.get':
            return self.snapshot()
        if method == 'device.command':
            return self.command(params)
        if method == 'pressure.status':
            require(not params, '该请求不接受参数')
            return self.array.status()
        if method == 'pressure.zero.start':
            require(not params, '该请求不接受参数')
            require(not self.motion.active(), '真实执行机构会话期间不能修改阵列零点')
            self.unlocked()
            self.idle()
            self.array.start_correction()
            self.log('开始阵列零点修正，收集 25 个完整原始帧')
            self.publish()
            return self.array.status()
        if method == 'pressure.zero.clear':
            require(not params, '该请求不接受参数')
            self.array.clear_correction()
            self.log('阵列零点修正已取消')
            self.publish()
            return self.array.status()
        if method == 'pressure.mode':
            require(set(params) == {'mode'} and params['mode'] in ('press', 'grip'), '无效的阵列模式')
            self.array.configure(mode=params['mode'])
            self.publish()
            return self.array.status()
        if method == 'hardware.get':
            return {'config': copy.deepcopy(self.hardware.value), 'error': self.hardware.error,
                    'warnings': list(self.hardware.warnings),
                    'drivers': {'available': False, 'message': '仅使用真实硬件反馈；支持独立只读采集、执行机构诊断及受限电机启停（待实物验收）。未确认的首页指标保持 0；回零、升降动作及整机联动尚未接入。'}}
        if method == 'hardware.save':
            self.idle()
            require(not self.verification.active(), '验证期间不能修改设备配置')
            require(set(params) == {'config'}, '设备配置参数错误')
            previous = self.hardware.value
            result = self.hardware.save(params['config'])
            self.verification.invalidate()
            for manager in (self.motion, self.sensors):
                for section, session in manager.sessions.items():
                    if previous[section] == result[section]:
                        continue
                    pending_before = self.pending_connections.pop(section, None)
                    if not session.thread.is_alive() and pending_before is None:
                        continue
                    pending = dict(session=session, deadline=time.monotonic() + 3,
                                   control=session.status.get('purpose') == 'control')
                    if manager is self.motion:
                        session.stop(emergency=False, close=True)
                    else:
                        session.disconnect()
                    self.pending_connections[section] = pending
            self.log('设备连接草稿已保存；仅变更的活动设备等待关闭后只读重连，不恢复运动')
            return result
        if method == 'hardware.check':
            require(set(params) <= {'config', 'section'} and 'config' in params, '设备检查参数错误')
            return {'errors': validate_hardware(params['config'], complete=True, section=params.get('section'))}
        if method == 'config.get':
            return {'config': self.config.value, 'error': self.config.error}
        if method == 'config.update':
            self.idle()
            require(set(params) == {'config'}, '配置参数错误')
            saved = self.config.save(params['config'])
            self.select_library(saved['defaultLibrary'])
            self.log('试验配置已保存并生效')
            self.publish()
            self.emit('config', saved)
            return saved
        if method == 'logs.list':
            return self.records.logs()
        if method == 'records.list':
            return self.records.list(self.state['database'])
        if method == 'records.snapshot':
            run_id = params.get('runId') or self.state['runId']
            require(isinstance(run_id, str), '暂无试验记录，请先开始联动试验')
            count = self.records.count(run_id)
            require(count > 0, '暂无试验采样记录')
            return {'runId': run_id, 'count': count}
        if method == 'records.read':
            require(set(params) == {'runId', 'offset', 'limit'}, '记录分页参数错误')
            require(isinstance(params['runId'], str), '无效的记录编号')
            require(type(params['offset']) is int and params['offset'] >= 0, '无效的记录偏移')
            require(type(params['limit']) is int and 1 <= params['limit'] <= 250, '单次最多读取 250 条记录')
            return self.records.read(params['runId'], params['offset'], params['limit'])
        if method == 'system.suspend':
            self.stop('系统休眠：请求停止并断开真实设备')
            return None
        raise ValueError('不允许的请求方法')

    def safety_assessment(self):
        return assess_safety(self.safety, self.hardware.value, self.motion.snapshot(),
                             self.hardware.error, self.state['stopped'])

    def poll_hardware(self):
        for section, session in self.motion.sessions.items():
            for event in session.collect():
                self.log(f"真实诊断 {section}/{session.status['sessionId']} 主机时间 {event['time']:.3f}：{event['message']}")
            status = session.snapshot()
            if status['state'] in ('failed', 'disconnected') and self.motion_finished.get(section) != status['sessionId']:
                self.motion_finished[section] = status['sessionId']
                self.log(f"真实诊断 {section}/{status['sessionId']} 最终状态 {status['state']}，审计缺失 {status['auditDropped']} 条；机械停止未确认：{status['error'] or '无通信错误'}")
        for section, session in self.sensors.sessions.items():
            events, status = session.collect()
            session_id = status['sessionId']
            if events:
                self.records.append_sensor(session_id, events)
                self.sensor_sequences[section] = events[-1]['number']
            # Engineering units alone do not establish the mechanical role of a
            # channel. Keep sensor samples in their own records until mapped.
            if status['state'] in ('failed', 'disconnected') and self.sensor_finished.get(section) != session_id:
                end = dict(number=self.sensor_sequences.get(section, 0) + 1, kind='end', source='hardware',
                           section=section, sessionId=session_id, quality=status['quality'],
                           raw=None, value=None, receivedAt=status['finishedAt'], error=status['error'])
                self.records.append_sensor(session_id, [end])
                self.records.finish_sensor(status)
                self.sensor_finished[section] = session_id
                label = '拉力' if section == 'tension' else '位移'
                self.log(f'真实{label}采集已结束：' + (status['error'] or '已断开'))

    def close(self):
        try:
            self.stop('控制端关闭：请求停止并断开真实设备')
        finally:
            try:
                self.verification.close()
            finally:
                try:
                    self.sensors.close()
                    self.motion.close()
                    self.poll_hardware()
                    if self.motion.active():
                        self.log('真实诊断线程尚未退出，停止/关闭可能被系统驱动阻塞；必须现场确认机械安全')
                finally:
                    try:
                        self.array.close()
                    finally:
                        self.records.close()
