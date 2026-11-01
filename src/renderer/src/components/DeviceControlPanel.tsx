import { Icon } from './Icon'
import { DeviceSwitch } from './DeviceSwitch'
import { deviceNames } from '../domain/devices'
import type { DeviceId, ExperimentState } from '../domain/types'
import type { DeviceCommand } from '../../../shared/controller'

interface Props {
  state: ExperimentState
  online: boolean
  busy: boolean
  onCommand: (command: DeviceCommand) => void
  onNotify: (message: string) => void
}
const deviceIds: DeviceId[] = ['motor1', 'motor2', 'lift']

export function DeviceControlPanel({ state, online, busy, onCommand }: Props) {
  const correcting = state.array.correction?.collecting ?? false
  const startDisabled = !online || busy || state.stopped || state.running || correcting
  const unsupported = '尚无已确认的真实硬件动作协议或测量映射，暂不可用'
  return (
    <section className="panel">
      <div className="panel-head"><div className="panel-title">设备控制</div></div>
      <div className="control-body">
        {deviceIds.map(device => {
          const control = state.motorControl
          const axis = device === 'lift' ? undefined : control?.axes[device]
          // A pending start or unknown outcome must remain stoppable, even while another request is busy.
          const needsStop = Boolean(axis && (axis.state !== 'idle' || state.devices[device]))
          const label = device === 'lift' ? '暂不可用' : !online || !axis ? '未连接'
            : axis.state === 'starting' ? '启动中' : axis.state === 'stopping' ? '停止中'
            : axis.state === 'unknown' ? '状态未知' : state.devices[device] ? '运行中'
            : axis.canStart ? '待启动' : '不可启动'
          return <DeviceSwitch key={device} name={deviceNames[device]} checked={online && Boolean(state.devices[device])}
            statusLabel={label} disabled={!online || !control || !axis || (!needsStop && (startDisabled || !axis.canStart))}
            onToggle={() => {
              if (device !== 'lift' && control) onCommand({ type: 'motor', device, enabled: !needsStop,
                sessionId: control.sessionId, configVersion: control.configVersion })
            }} />
        })}
        <div className="pressure">
          <div className="pressure-head"><label htmlFor="pressure">夹爪气压</label><span><output>{state.pressure.toFixed(2)}</output> <small>MPa</small></span></div>
          <input id="pressure" type="range" min="0" max="0.6" step="0.01" value={state.pressure} disabled title={unsupported}
            onChange={event => onCommand({ type: 'pressure', value: event.currentTarget.valueAsNumber })}
            onPointerUp={() => onCommand({ type: 'commitPressure' })}
            onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onCommand({ type: 'commitPressure' }) }} />
          <div className="range-ends"><span>0.00</span><span>0.60</span></div>
        </div>
        <div className="prepare-actions">
          <button className="btn" disabled title={unsupported}>初始化</button>
          <button className="btn" disabled title={unsupported}>轴回零</button>
          <button className="btn" disabled title={unsupported}>传感器置零</button>
        </div>
        <button className="btn primary" disabled={!state.running || !online} title={state.running ? undefined : unsupported}
          onClick={() => onCommand({ type: 'stop' })}><Icon name="play" /><span>{state.running ? '停止试验' : '联动开始'}</span></button>
      </div>
    </section>
  )
}
