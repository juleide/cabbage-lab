import type { DeviceCommand, DisplayRange, LabState } from '../../../shared/controller'
import { DeviceControlPanel } from '../components/DeviceControlPanel'
import { MetricsPanel } from '../components/MetricsPanel'
import { PressureMapPanel } from '../components/PressureMapPanel'
import { DataActionsPanel } from '../components/DataActionsPanel'

interface Props {
  range: DisplayRange
  notify: (message: string) => void
  state: LabState | null
  online: boolean
  busy: boolean
  exporting: boolean
  error: string
  onCommand: (command: DeviceCommand) => void
  onExport: () => void
  onLogs: () => void
  onSettings: () => void
}

export function Dashboard({ range, notify, state, online, busy, exporting, error, onCommand, onExport, onLogs, onSettings }: Props) {
  if (!state) {
    return (
      <main className="controller-empty panel">
        <h2>等待 Python 控制端就绪</h2>
        <p>{error || '正在连接 Python 控制端，请稍候…'}</p>
        <p>未收到有效真实读数时，实时参数显示为 0。</p>
        <button className="btn" onClick={onSettings}>打开设置与诊断</button>
      </main>
    )
  }
  const idle = !state.running && !Object.values(state.devices).some(Boolean)
  return (
    <main className={`layout${online ? '' : ' dashboard-offline'}`}>
      {!online && <div className="offline-banner" role="alert">设备状态未知 · {error}，请在设置页检查控制端。</div>}
      <DeviceControlPanel state={state} online={online} busy={busy} onCommand={onCommand} onNotify={notify} />
      <MetricsPanel values={state.values} stopped={state.stopped} online={online}
        hasReadings={Object.values(state.measurementQuality ?? {}).some(reading => reading.valid)} />
      <div className="right-col">
        <PressureMapPanel range={range} idle={idle} notify={notify} onEmergency={() => onCommand({ type: 'emergency' })} />
        <DataActionsPanel database={state.database} running={state.running} online={online} idle={idle}
          exporting={exporting} onDatabaseChange={value => onCommand({ type: 'database', value })}
          onExport={onExport} onLogs={onLogs} />
      </div>
    </main>
  )
}
