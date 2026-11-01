import { Select } from './Select'
import { Icon } from './Icon'

interface Props {
  database: string
  running: boolean
  exporting: boolean
  online: boolean
  idle: boolean
  onDatabaseChange: (value: string) => void
  onExport: () => void
  onLogs: () => void
}
export function DataActionsPanel({ database, running, exporting, online, idle, onDatabaseChange, onExport, onLogs }: Props) {
  return (
    <section className="panel utility">
      <label className="database"><Select icon={<Icon name="db" />} aria-label="记录库选择" value={database} disabled={!online || running || !idle} onChange={event => onDatabaseChange(event.currentTarget.value)}>
        <option value="cabbage_test_2026">当前记录库</option><option value="cabbage_test_archive">归档记录库</option>
      </Select></label>
      <div className="utility-actions">
        <button className="btn" onClick={onExport} disabled={!online || exporting}><Icon name="download" />{exporting ? '正在导出…' : '数据导出'}</button>
        <button className="btn" onClick={onLogs}><Icon name="log" />运行日志</button>
      </div>
    </section>
  )
}
