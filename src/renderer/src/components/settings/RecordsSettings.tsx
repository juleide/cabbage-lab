import { useEffect, useState } from 'react'
import type { AppInfo, RunRecord } from '../../../../shared/controller'

interface Props {
  info: AppInfo | null
  online: boolean
  library: string | undefined
  exporting: boolean
  loadRecords: () => Promise<RunRecord[]>
  onExport: (runId: string) => void
  onDirectory: (kind: 'data' | 'logs' | 'config') => void
}
const statuses: Record<RunRecord['status'], string> = {
  running: '记录中', completed: '已完成', stopped: '已停止', emergency: '急停结束', interrupted: '异常中断'
}
export function RecordsSettings({ info, online, library, exporting, loadRecords, onExport, onDirectory }: Props) {
  const [records, setRecords] = useState<RunRecord[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    if (!online) return
    setLoading(true)
    loadRecords().then(result => {
      if (live) { setRecords(result); setError('') }
    }).catch(reason => { if (live) setError(reason.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [online, library, loadRecords, revision])
  return (
    <section className="settings-card">
      <h3>数据与日志</h3>
      <dl className="settings-details">
        <div><dt>试验数据</dt><dd>{info?.dataDir || '等待应用信息'}</dd></div>
        <div><dt>控制配置</dt><dd>{info?.configDir || '—'}</dd></div>
        <div><dt>运行日志</dt><dd>{info?.logsDir || '—'}</dd></div>
      </dl>
      <div className="settings-actions">
        <button className="btn" onClick={() => onDirectory('data')}>打开数据目录</button>
        <button className="btn" onClick={() => onDirectory('config')}>打开配置目录</button>
        <button className="btn" onClick={() => onDirectory('logs')}>打开日志目录</button>
      </div>
      <h3>最近试验 · {library === 'cabbage_test_archive' ? '归档记录库' : '当前记录库'}</h3>
      <button className="btn" disabled={!online || loading} onClick={() => setRevision(value => value + 1)}>{loading ? '读取中…' : '刷新记录'}</button>
      {error && <p className="settings-warning">{error}</p>}
      {!online && <p className="settings-warning">控制端离线，记录列表可能不是最新状态。</p>}
      <div className="record-list">
        {!records.length && <p>暂无记录。开始联动试验后，数据将自动保存到本机。</p>}
        {records.map(record => (
          <div className="record-row" key={record.id}>
            <div><strong>{record.id}</strong><small>{new Date(record.startedAt).toLocaleString('zh-CN')} · {statuses[record.status]} · {record.sampleCount} 组</small></div>
            <button className="btn" disabled={!online || exporting || !record.sampleCount} onClick={() => onExport(record.id)}>导出 CSV</button>
          </div>
        ))}
      </div>
      <p className="settings-hint">显示所选记录库最近 50 次试验。记录保存在本机，重启后仍可查看和导出，不会自动归档。</p>
    </section>
  )
}
