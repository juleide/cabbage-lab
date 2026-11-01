import { memo, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ArrayStatistics, DisplayRange } from '../../../shared/controller'
import type { PressureView, ReceivedPressureFrame } from '../hooks/usePressureArray'
import { drawPressureMap } from '../graphics/pressureMap'

export interface SelectedPoint { row: number; column: number }
export interface FrameReadout {
  sequence: number
  capturedAt: string
  raw: ArrayStatistics
  display: ArrayStatistics
  corrected: boolean
  point: { raw: number; display: number } | null
}
interface Props {
  latest: RefObject<ReceivedPressureFrame | null>
  view: PressureView
  range: DisplayRange
  selected: SelectedPoint | null
  onSelect: (point: SelectedPoint) => void
  onReadout: (readout: FrameReadout | null, message: string) => void
}

export const PressureHeatmap = memo(function PressureHeatmap({ latest, view, range, selected, onSelect, onReadout }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [message, setMessage] = useState('等待完整阵列帧')
  const { online, paused, switching, error, generation, processingVersion } = view

  useEffect(() => {
    let animation = 0
    let lastPaint = -Infinity
    let paintedSequence = -1
    let readout: FrameReadout | null = null
    const element = canvas.current!
    const clear = () => {
      drawPressureMap(element, Array(4096).fill(0), range)
      paintedSequence = -1
    }
    if (paused || switching || !latest.current) clear()
    const render = (now: number) => {
      if (now - lastPaint >= 100) {
        lastPaint = now
        const received = latest.current
        const status = !online ? '控制端离线 · 非实时画面'
          : paused ? '采集已暂停'
          : switching ? '正在处理阵列操作'
          : error ? `阵列采集异常：${error}`
          : !received ? '等待完整阵列帧'
          : now - received.receivedAt > 1000 ? '阵列数据超时 · 非实时画面' : ''
        setMessage(previous => previous === status ? previous : status)
        if (status) {
          clear()
          readout = null
        } else if (received && received.frame.sequence !== paintedSequence) {
          const frame = received.frame
          drawPressureMap(element, frame.displayValues, range)
          paintedSequence = frame.sequence
          const index = selected ? selected.row * 64 + selected.column : null
          readout = {
            sequence: frame.sequence, capturedAt: frame.capturedAt, raw: frame.rawStatistics,
            display: frame.displayStatistics, corrected: frame.correction.active,
            point: index === null ? null : { raw: frame.values[index], display: frame.displayValues[index] }
          }
        }
        onReadout(readout, status)
      }
      animation = requestAnimationFrame(render)
    }
    animation = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animation)
  }, [latest, online, paused, switching, error, generation, processingVersion, range, selected, onReadout])

  return (
    <>
      <canvas ref={canvas} className={message ? 'heatmap-inactive' : ''} width={640} height={640}
        role="img" aria-label="64乘64真实阵列等待区，点击查看点位值" onPointerDown={event => {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (!bounds.width || !bounds.height) return
          const column = Math.floor((event.clientX - bounds.left) / bounds.width * 64)
          const row = Math.floor((event.clientY - bounds.top) / bounds.height * 64)
          if (row >= 0 && row < 64 && column >= 0 && column < 64) onSelect({ row, column })
        }} />
      {!message && selected && <span className="selected-point" style={{ left: `${(selected.column + 0.5) / 64 * 100}%`, top: `${(selected.row + 0.5) / 64 * 100}%` }} />}
      {message && <span className="heatmap-message" role="status">{message}</span>}
    </>
  )
})
