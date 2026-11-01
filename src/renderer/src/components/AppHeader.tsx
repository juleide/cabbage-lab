import { Icon } from './Icon'
import type { LabState } from '../../../shared/controller'

interface Props {
  readiness?: LabState['readiness']
  stopped: boolean
  running: boolean
  online: boolean
  onSettings: () => void
  onEmergency: () => void
  onReset: () => void
}
export function AppHeader({ readiness, stopped, running, online, onSettings, onEmergency, onReset }: Props) {
  return (
    <header>
      <div className="brand">
        <div className="mark"><Icon name="leaf" /></div>
        <h1>甘蓝检测多功能试验台</h1>
      </div>
      <div className="header-right">
        <button className="settings-icon" type="button" aria-label="设置" title="设置" onClick={onSettings}><Icon name="settings" /></button>
        <div className={`connection${online ? '' : ' offline'}`}>
          <i className="dot" />
          <span title={readiness ? Object.values(readiness.devices).filter(device => device.state !== 'ready').map(device => device.reason).join('；') : undefined}>{!online ? '控制端离线' : stopped ? '设备已急停' : readiness?.state === 'fault' ? '设备异常' : running ? '联动试验中' : readiness?.state === 'ready' ? '设备已就绪' : readiness?.state === 'connecting' ? '设备连接中' : '设备未就绪'}</span>
        </div>
        {stopped
          ? <button className="emergency" disabled={!online} onClick={onReset}>解除急停</button>
          : <button className="emergency" disabled={!online} onClick={onEmergency}><Icon name="stop" />紧急停止</button>}
      </div>
    </header>
  )
}
