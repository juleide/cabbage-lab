import copy
import logging
import math
import uuid
import time
from datetime import datetime
from ..array.acquisition import ArrayAcquisition
from ..devices.simulated import DEVICE_NAMES, SimulatedDevice
from ..devices.ports import list_ports
from ..storage.config import ConfigStore, LIBRARIES
from ..storage.records import RecordStore
from ..storage.hardware import HardwareStore, validate as validate_hardware


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
        self.device.stop()
        if self.state['running']:
            self.records.finish(self.state['runId'], now(), 'emergency' if emergency else 'stopped')
        self.state['running'] = False
        if emergency:
            self.state['stopped'] = True
        self.log(reason)
        self.publish()

    def publish_array(self):
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
        if kind == 'emergency':
            if not self.state['stopped']:
                self.stop('紧急停止：全部模拟执行机构停止，控制操作已锁定', emergency=True)
            return {'message': '已紧急停止'}
        if kind == 'stop':
            self.stop('停止设备：全部模拟执行机构停止')
            return {'message': '设备已停止'}
        if kind == 'reset':
            require(self.state['stopped'], '当前未处于急停状态')
            self.state['stopped'] = False
            self.state['zero'] = True
            message = '急停已解除，设备恢复待机，请重新检查并启动设备'
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
        if method == 'hardware.ports.list':
            require(not params, '该请求不接受参数')
            return list_ports()
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
                    'drivers': {'available': False, 'message': '当前版本未接入真实串口及 USB 驱动；配置可保存，不影响模拟试验。'}}
        if method == 'hardware.save':
            self.idle()
            require(set(params) == {'config'}, '设备配置参数错误')
            result = self.hardware.save(params['config'])
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

    def close(self):
        try:
            self.stop('控制端关闭：停止试验和全部模拟执行机构')
        finally:
            try:
                self.array.close()
            finally:
                self.records.close()
