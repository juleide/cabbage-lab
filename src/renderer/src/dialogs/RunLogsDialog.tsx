import { Modal } from '../components/Modal'
import type { LogEntry } from '../domain/types'

export function RunLogsDialog({ logs, onClose }: { logs: readonly LogEntry[]; onClose: () => void }) {
  return <Modal title="运行日志" onClose={onClose}><div className="log-list">{logs.map((entry, index) => <div className="log-item" key={`${entry.time}-${index}`}><time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}</time>{entry.message}</div>)}</div></Modal>
}
