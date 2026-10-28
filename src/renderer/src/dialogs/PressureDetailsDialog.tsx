import type { ReactNode } from 'react'
import type { FrameReadout, SelectedPoint } from '../components/PressureHeatmap'
import type { PressureView } from '../hooks/usePressureArray'
import { Modal } from '../components/Modal'

interface Props {
  children: ReactNode
  view: PressureView
  readout: FrameReadout | null
  selected: SelectedPoint | null
  stale: string
  idle: boolean
  onEmergency: () => void
  onStart: () => void
  onClear: () => void
  onClose: () => void
}
const number = (value: number | undefined) => value === undefined ? '—' : value.toFixed(2)

export function PressureDetailsDialog({ children, view, readout, selected, stale, idle, onEmergency, onStart, onClear, onClose }: Props) {
  const correction = view.correction
  return (
    <Modal title="云图详情 · 模拟阵列" className="pressure-details-dialog" onClose={onClose}>
      <div className="pressure-details-grid">
        <div className="pressure-details-map">{children}</div>
        <div className="pressure-details-info">
          <p className="pressure-frame-time">{readout ? new Date(readout.capturedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '等待完整帧'} · {stale || '实时'}</p>
          <table className="pressure-statistics">
            <thead><tr><th>统计项</th><th>原始值</th><th>显示值</th></tr></thead>
            <tbody>
              <tr><th>最大值</th><td>{number(readout?.raw.maximum)}</td><td>{number(readout?.display.maximum)}</td></tr>
              <tr><th>最小值</th><td>{number(readout?.raw.minimum)}</td><td>{number(readout?.display.minimum)}</td></tr>
              <tr><th>平均值</th><td>{number(readout?.raw.mean)}</td><td>{number(readout?.display.mean)}</td></tr>
              <tr><th>最大值位置</th><td>{readout ? `${readout.raw.maxRow + 1}行 ${readout.raw.maxColumn + 1}列` : '—'}</td><td>{readout ? `${readout.display.maxRow + 1}行 ${readout.display.maxColumn + 1}列` : '—'}</td></tr>
            </tbody>
          </table>
          <p className="pressure-point-info">{selected && readout?.point
            ? `${selected.row + 1}行 ${selected.column + 1}列 · 原始 ${number(readout.point.raw)} · 修正 ${number(readout.point.display)}`
            : '点击云图选择点位，坐标范围为 1～64。'}</p>
          <div className="pressure-correction-status" role="status">
            {correction.collecting ? `正在收集零点参考 ${correction.collected}/${correction.target} 帧`
              : correction.active ? '零点修正已启用' : '未启用零点修正'}
            {correction.appliedAt && <small>参考时间：{new Date(correction.appliedAt).toLocaleTimeString('zh-CN')}</small>}
          </div>
          {correction.error && <p className="settings-warning">{correction.error}</p>}
          <div className="settings-actions">
            <button className="btn" disabled={!view.online || !idle || !!stale || view.paused || view.switching || correction.collecting} onClick={onStart}>阵列零点修正</button>
            <button className="btn" disabled={!view.online || view.switching || (!correction.active && !correction.collecting)} onClick={onClear}>{correction.collecting ? '取消收集与修正' : '取消修正'}</button>
            <button className="emergency" disabled={!view.online || view.paused} onClick={onEmergency}>紧急停止</button>
          </div>
          <p className="settings-hint">修正前请卸载传感器上的负载并停止全部执行机构。原始数据不变，基线仅在当前会话有效。</p>
        </div>
      </div>
    </Modal>
  )
}
