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

export function DeviceControlPanel({ state, online, busy, onCommand, onNotify }: Props) {
  const actuatorsActive = deviceIds.some(device => state.devices[device])
  const correcting = state.array.correction?.collecting ?? false
  const disabled = !online || busy || state.stopped || state.running || correcting

  function requestIdleAction(type: 'home' | 'zero') {
    if (state.running) { onNotify('请先停止试验'); return }
    if (actuatorsActive) { onNotify('请先关闭电机和升降装置'); return }
    onCommand({ type })
  }
  return (
    <section className="panel">
      <div className="panel-head"><div className="panel-title">设备控制</div></div>
      <div className="control-body">
        {deviceIds.map(device => <DeviceSwitch key={device} name={deviceNames[device]} checked={state.devices[device]} disabled={disabled} onToggle={() => onCommand({ type: 'toggle', device })} />)}
        <div className="pressure">
          <div className="pressure-head"><label htmlFor="pressure">夹爪气压</label><span><output>{state.pressure.toFixed(2)}</output> <small>MPa</small></span></div>
          <input id="pressure" type="range" min="0" max="0.6" step="0.01" value={state.pressure} disabled={disabled}
            onChange={event => onCommand({ type: 'pressure', value: event.currentTarget.valueAsNumber })}
            onPointerUp={() => onCommand({ type: 'commitPressure' })}
            onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onCommand({ type: 'commitPressure' }) }} />
          <div className="range-ends"><span>0.00</span><span>0.60</span></div>
        </div>
        <div className="prepare-actions">
          <button className="btn" disabled={disabled} onClick={() => onCommand({ type: 'initialize' })}>初始化</button>
          <button className="btn" disabled={disabled} onClick={() => requestIdleAction('home')}>轴回零</button>
          <button className="btn" disabled={disabled} onClick={() => requestIdleAction('zero')}>传感器置零</button>
        </div>
        <button className="btn primary" disabled={!online || busy || state.stopped || correcting} onClick={() => onCommand({ type: 'run' })}><Icon name="play" /><span>{state.running ? '停止试验' : '联动开始'}</span></button>
      </div>
    </section>
  )
}
