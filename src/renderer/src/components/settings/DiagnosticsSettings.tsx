import { useArrayDiagnostics } from '../../hooks/useArrayDiagnostics'
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
  const array = useArrayDiagnostics(online)
  const diagnostic = array.status?.diagnostics
  const correction = array.status?.correction
  return (
    <section className="settings-card">
      <h3>运行与诊断</h3>
      <dl className="settings-details">
        <div><dt>应用版本</dt><dd>{info?.version || '—'}</dd></div>
        <div><dt>运行平台</dt><dd>{info?.platform || '—'}</dd></div>
        <div><dt>运行环境</dt><dd>真实硬件接入（设备连接及采集状态见设备连接页）</dd></div>
        <div><dt>控制端</dt><dd>{online ? 'Python 在线' : '离线 · 设备状态未知'}</dd></div>
        <div><dt>Python 命令</dt><dd>{info?.python || 'python3 / python'}（要求 Python 3.10+）</dd></div>
      </dl>
      {error && <p className="settings-warning" role="alert">{error}</p>}
      <div className="settings-actions">
        <button className="btn" disabled={!online} onClick={onStop}>停止全部执行机构</button>
        <button className="btn" disabled={busy || (online && !idle)} onClick={onRestart}>重启控制进程</button>
      </div>
      <h3>阵列采集</h3>
      <dl className="settings-details">
        <div><dt>数据来源</dt><dd>真实阵列（未接入时无数据）· {array.status?.mode === 'grip' ? '抓取' : '按压'}</dd></div>
        <div><dt>采集帧率</dt><dd>{online ? (diagnostic?.captureFps ?? 0).toFixed(1) : '0.0'} FPS</dd></div>
        <div><dt>界面接收帧率</dt><dd>{array.receiveFps.toFixed(1)} FPS</dd></div>
        <div><dt>最近完整帧</dt><dd>{diagnostic?.lastFrameAt ? new Date(diagnostic.lastFrameAt).toLocaleString('zh-CN') : '尚未收到'}{!online && ' · 非实时'}</dd></div>
        <div><dt>有效帧数</dt><dd>{diagnostic?.validFrames ?? '—'}</dd></div>
        <div><dt>CRC 错误</dt><dd>{diagnostic?.crcErrors ?? '—'}</dd></div>
        <div><dt>残帧丢弃</dt><dd>{diagnostic?.droppedFrames ?? '—'}</dd></div>
        <div><dt>零点修正</dt><dd>{correction?.collecting ? `收集中 ${correction.collected}/${correction.target}` : correction?.active ? '已启用' : '未启用'}{!online && ' · 上次状态'}</dd></div>
      </dl>
      {(array.error || array.status?.error || correction?.error) && <p className="settings-warning">{array.error || array.status?.error || correction?.error}</p>}
      <p className="settings-hint">重启前请停止试验、停止并断开真实诊断设备，现场确认机械安全。重启后软件待机，不自动恢复试验；不能据此确认机械已停止。</p>
      <p className="settings-warning">软件停止不能替代硬件急停与安全联锁。</p>
    </section>
  )
}
