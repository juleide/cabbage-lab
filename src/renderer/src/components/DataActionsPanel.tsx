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
      <label className="database"><Icon name="db" /><select aria-label="记录库选择" value={database} disabled={!online || running || !idle} onChange={event => onDatabaseChange(event.currentTarget.value)}>
        <option value="cabbage_test_2026">当前记录库</option><option value="cabbage_test_archive">归档记录库</option>
      </select><svg className="database-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></label>
      <div className="utility-actions">
        <button className="btn" onClick={onExport} disabled={!online || exporting}><Icon name="download" />{exporting ? '正在导出…' : '数据导出'}</button>
        <button className="btn" onClick={onLogs}><Icon name="log" />运行日志</button>
      </div>
    </section>
  )
}
