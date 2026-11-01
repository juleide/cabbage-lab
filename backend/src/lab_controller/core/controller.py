import copy
import logging
import math
import json
import uuid
import time
from datetime import datetime
from ..array.acquisition import ArrayAcquisition
from ..devices.simulated import DEVICE_NAMES, SimulatedDevice
from ..devices.ports import list_ports
from ..devices.verification import VerificationManager, SUPPORTED
from ..devices.sensors import SensorManager, SECTIONS as SENSOR_SECTIONS
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
        self.motion_finished = {}
        self.sensor_finished = {}
        self.sensor_sequences = {}
        self.records = RecordStore(root / 'data' / 'experiments.sqlite3')
        self.device = SimulatedDevice()
        self.state = {
            'devices': self.device.outputs.copy(), 'initialized': False, 'running': False,
            'stopped': False, 'zero': False, 'pressure': self.config.value['defaultPressure'],
            'tick': 0, 'values': {}, 'database': self.config.value['defaultLibrary'],
            'runId': None, 'sampleCount': 0,
        }
        self.select_library(self.state['database'])
        self.array = ArrayAcquisition()
        self.last_array_sequence = -1
        self.next_array_publish = 0.0
        self.refresh()
        self.log('Python 控制端已启动 · 模拟设备待机，不自动启动执行机构')
        if self.config.error:
            self.log(self.config.error)

    def refresh(self):
        self.array.configure(paused=self.state['stopped'])
        self.state['array'] = self.array.status()
        self.state['devices'] = self.device.outputs.copy()
        self.state['values'] = (dict.fromkeys(('normal', 'area', 'friction', 'speed', 'coefficient', 'pressure'), 0)
                                if self.state['stopped'] else self.device.read(
                                    self.state['tick'], self.state['zero'], self.state['running'], self.state['pressure']))

    def snapshot(self):
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
        require(not self.state['running'] and not any(self.device.outputs.values()), '请先停止试验和全部执行机构')

    def unlocked(self):
        require(not self.state['stopped'], '设备已急停，请先确认安全并解除急停')

    def select_library(self, library):
        self.state['database'] = library
        runs = self.records.list(library)
        self.state['runId'] = runs[0]['id'] if runs else None
        self.state['sampleCount'] = runs[0]['sampleCount'] if runs else 0

    def stop(self, reason, emergency=False):
        self.motion.stop(emergency=emergency, close=True)
        self.verification.cancel()
        self.sensors.disconnect()
        self.device.stop()
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
        if self.state['stopped']:
            return
        self.state['tick'] += self.config.value['sampleIntervalMs'] / 100
        self.refresh()
        if self.state['running']:
            number = self.state['sampleCount'] + 1
            self.records.append(self.state['runId'], number, now(), self.state['values'])
            self.state['sampleCount'] = number
        self.emit('state', self.state)

    def command(self, command):
        require(isinstance(command, dict) and isinstance(command.get('type'), str), '无效的控制命令')
        kind = command['type']
        expected = {'toggle': {'type', 'device'}, 'pressure': {'type', 'value'}, 'database': {'type', 'value'}}
        require(set(command) == expected.get(kind, {'type'}), '控制命令参数错误')
        if kind not in ('emergency', 'stop'):
            require(not self.motion.active(), '真实执行机构诊断期间不能操作模拟设备，请先停止并断开诊断')
            require(not self.verification.active(), '只读验证期间不能操作设备，请等待或取消验证')
            require(not self.sensors.active(), '真实传感器采集期间不能操作模拟设备，请先断开传感器')
        if kind == 'emergency':
            self.stop('紧急停止：模拟设备停止；已连接真实诊断设备排队发送停止，机械结果待现场确认', emergency=True)
            return {'message': '模拟设备已急停；真实设备停止仅为尽力请求，请现场确认'}
        if kind == 'stop':
            self.stop('停止设备：全部模拟执行机构停止')
            return {'message': '模拟设备已停止；真实诊断设备已请求停止并断开，机械结果未确认'}
        if kind == 'reset':
            require(self.state['stopped'], '当前未处于急停状态')
            self.state['stopped'] = False
            self.state['zero'] = True
            message = '模拟急停已解除，软件恢复待机；不会清除真实驱动器故障，请现场确认安全'
        elif kind == 'database':
            self.idle()
            require(command['value'] in LIBRARIES, '无效的记录库')
            self.select_library(command['value'])
            message = '已切换记录库'
        else:
            self.unlocked()
            if kind == 'toggle' or (kind == 'run' and not self.state['running']):
                require(not self.array.status()['correction']['collecting'], '阵列零点修正收集中，请等待完成或取消修正')
            if kind == 'run':
                if self.state['running']:
                    self.state['running'] = False
                    self.records.finish(self.state['runId'], now(), 'completed')
                    message = f"试验已结束，共记录 {self.state['sampleCount']} 组数据"
                else:
                    require(self.device.outputs['motor1'] and self.device.outputs['motor2'], '请先启动 1 号与 2 号电机')
                    run_id = f"{self.config.value['recordPrefix']}-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}"
                    self.records.begin(run_id, self.state['database'], now(), self.config.value)
                    self.state.update(running=True, zero=False, runId=run_id, sampleCount=0)
                    message = '联动试验已开始'
            else:
                require(not self.state['running'], '联动试验中不能执行该操作')
                if kind == 'toggle':
                    name = command['device']
                    require(isinstance(name, str) and name in DEVICE_NAMES, '无效的执行机构')
                    enabled = not self.device.outputs[name]
                    self.device.set_output(name, enabled)
                    message = DEVICE_NAMES[name] + ('启动' if enabled else '停止')
                elif kind == 'pressure':
                    pressure = command['value']
                    require(type(pressure) in (int, float) and math.isfinite(pressure) and 0 <= pressure <= 0.6, '模拟气压必须在 0～0.6 MPa 范围内')
                    self.state['pressure'] = pressure
                    self.publish()
                    return {'message': ''}
                elif kind == 'commitPressure':
                    message = f"夹爪气压已设定为 {self.state['pressure']:.2f} MPa"
                elif kind in ('initialize', 'home', 'zero'):
                    if kind != 'initialize':
                        self.idle()
                    if kind == 'initialize':
                        self.array.clear_correction()
                        self.device.stop()
                        self.state.update(initialized=True, zero=False, pressure=self.config.value['defaultPressure'])
                        message = '初始化完成 · 使用已保存的默认气压，历史记录不会删除'
                    elif kind == 'zero':
                        self.state['zero'] = True
                        message = '传感器已置零'
                    else:
                        message = '运动轴已回到原点（模拟）'
                else:
                    raise ValueError('不支持的控制命令')
        self.log(message)
        self.publish()
        return {'message': message}

    def request(self, method, params):
        require(isinstance(params, dict), '请求参数必须是对象')
        self.poll_hardware()
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
        if method == 'hardware.motion.status':
            require(not params, '该请求不接受参数')
            return self.motion.snapshot()
        if method == 'hardware.motion.connect':
            require(set(params) == {'section'} and params['section'] in MOTION_SECTIONS, '请选择电机或升降')
            self.idle()
            self.unlocked()
            require(not self.verification.active() and not self.sensors.active(), '请先结束只读验证及传感器采集')
            require(not self.hardware.error, self.hardware.error or '')
            section = params['section']
            errors = validate_hardware(self.hardware.value, complete=True, section=section)
            require(not errors, '；'.join(errors))
            # Persist intent before opening a device. Stop audit is drained by the main thread.
            config = self.hardware.value[section]
            self.log(f'真实执行机构诊断连接请求 {section} 配置快照：' + json.dumps(config, ensure_ascii=False, sort_keys=True))
            session = self.motion.connect(section, config)
            self.log(f"真实诊断会话 {session.status['sessionId']} 已创建，配置指纹 {session.status['configVersion']}；禁止启动、使能和回零，停止结果须现场确认")
            return self.motion.snapshot()
        if method in ('hardware.motion.stop', 'hardware.motion.disconnect'):
            expected = {'section', 'emergency'} if method.endswith('.stop') else {'section'}
            require(set(params) == expected and params.get('section') in MOTION_SECTIONS, '执行机构停止参数错误')
            require(method.endswith('.disconnect') or type(params['emergency']) is bool, '急停参数必须为布尔值')
            session = self.motion.sessions.get(params['section'])
            require(session is not None and session.thread.is_alive(), '该执行机构没有活动诊断连接')
            self.motion.stop(params['section'], emergency=params.get('emergency', False), close=method.endswith('.disconnect'))
            return self.motion.snapshot()
        if method == 'system.motion.lock':
            require(not params, '该请求不接受参数')
            self.motion.stop(emergency=True, close=True)
            return None
        if method == 'hardware.sensors.status':
            require(not params, '该请求不接受参数')
            return self.sensors.snapshot()
        if method == 'hardware.sensors.connect':
            require(not self.motion.active(), '真实执行机构诊断期间请勿启动传感器采集')
            require(set(params) == {'section'} and params['section'] in SENSOR_SECTIONS, '请选择拉力或位移传感器')
            self.idle()
            self.unlocked()
            require(not self.verification.active(), '请先等待或取消只读验证')
            require(not self.hardware.error, self.hardware.error or '')
            section = params['section']
            errors = validate_hardware(self.hardware.value, complete=True, section=section)
            require(not errors, '；'.join(errors))
            config = self.hardware.value[section]
            session = self.sensors.connect(section, config)
            self.sensor_sequences[section] = 0
            stored = False
            try:
                self.records.begin_sensor(session.snapshot(), config)
                stored = True
                session.thread.start()
            except Exception as exc:
                self.sensors.sessions.pop(section, None)
                if stored:
                    failed = session.snapshot()
                    failed.update(state='failed', finishedAt=time.time(), error=f'启动采集线程失败：{exc}')
                    self.records.finish_sensor(failed)
                raise
            label = '拉力' if section == 'tension' else '位移'
            self.log(f'真实{label}只读采集已启动，数据独立记录，不改变模拟试验数据来源')
            return self.sensors.snapshot()
        if method == 'hardware.sensors.disconnect':
            require(set(params) == {'section'} and params['section'] in SENSOR_SECTIONS, '请选择拉力或位移传感器')
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
            require(not self.motion.active(), '请先停止并断开真实执行机构诊断')
            require(not self.sensors.active(), '请先断开持续采集的传感器再进行只读验证')
            require(set(params) == {'section'} and params['section'] in SUPPORTED,
                    '请选择电机、拉力或位移分类进行只读验证；升降及电子皮肤尚不支持')
            self.idle()
            require(not self.hardware.error, self.hardware.error or '')
            section = params['section']
            errors = validate_hardware(self.hardware.value, complete=True, section=section)
            require(not errors, '；'.join(errors))
            config = self.hardware.value[section]
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
                    'drivers': {'available': False, 'message': '当前试验仍使用模拟设备；支持只读采集和执行机构状态/停止诊断，禁止真实启动、使能、回零及 USB 采集。'}}
        if method == 'hardware.save':
            self.idle()
            require(not self.motion.active(), '执行机构诊断期间不能修改配置，请先停止并断开')
            require(not self.sensors.active(), '持续采集期间不能修改设备配置，请先断开传感器')
            require(not self.verification.active(), '验证期间不能修改设备配置')
            require(set(params) == {'config'}, '设备配置参数错误')
            result = self.hardware.save(params['config'])
            self.verification.invalidate()
            self.log('设备连接草稿已保存，未连接真实硬件')
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
            self.state['pressure'] = saved['defaultPressure']
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
            self.stop('系统休眠：停止试验和全部模拟执行机构')
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
            self.stop('控制端关闭：停止试验和全部模拟执行机构')
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
