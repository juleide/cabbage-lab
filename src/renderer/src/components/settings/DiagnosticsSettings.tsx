import type { AppInfo } from '../../../../shared/controller'

interface Props {
  info: AppInfo | null
  online: boolean
  idle: boolean
  busy: boolean
  error: string
  onRestart: () => void
  onStop: () => void
}
export function DiagnosticsSettings({ info, online, idle, busy, error, onRestart, onStop }: Props) {
  return (
    <section className="settings-card">
      <h3>运行与诊断</h3>
      <dl className="settings-details">
        <div><dt>应用版本</dt><dd>{info?.version || '—'}</dd></div>
        <div><dt>运行平台</dt><dd>{info?.platform || '—'}</dd></div>
        <div><dt>运行环境</dt><dd>模拟设备（未连接真实硬件）</dd></div>
        <div><dt>控制端</dt><dd>{online ? 'Python 在线' : '离线 · 设备状态未知'}</dd></div>
        <div><dt>Python 命令</dt><dd>{info?.python || 'python3 / python'}（要求 Python 3.10+）</dd></div>
      </dl>
      {error && <p className="settings-warning" role="alert">{error}</p>}
      <div className="settings-actions">
        <button className="btn" disabled={!online} onClick={onStop}>停止全部执行机构</button>
        <button className="btn" disabled={busy || (online && !idle)} onClick={onRestart}>重启控制进程</button>
      </div>
      <p className="settings-hint">重启前请停止试验和全部执行机构。重启后保持待机，不会自动恢复试验。</p>
      <p className="settings-warning">软件停止不能替代硬件急停与安全联锁。</p>
    </section>
  )
}
