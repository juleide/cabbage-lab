import { Modal } from '../components/Modal'

export function EmergencyResetDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return <Modal title="解除急停" onClose={onClose}><p className="modal-text">请确认试验台周围安全、执行机构已停止且异常已排除。解除后设备将恢复待机，需要重新启动电机。</p><button className="btn primary full" onClick={onConfirm}>确认安全，解除急停</button></Modal>
}
