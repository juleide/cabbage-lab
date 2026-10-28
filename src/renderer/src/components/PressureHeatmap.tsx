import { memo, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { PressureView, ReceivedPressureFrame } from '../hooks/usePressureArray'
import { drawPressureMap } from '../graphics/pressureMap'

interface Props {
  latest: RefObject<ReceivedPressureFrame | null>
  view: PressureView
}

export const PressureHeatmap = memo(function PressureHeatmap({ latest, view }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [message, setMessage] = useState('等待完整阵列帧')

  useEffect(() => {
    let animation = 0
    let lastPaint = -Infinity
    let paintedSequence = -1
    const element = canvas.current!
    const clear = () => element.getContext('2d')?.clearRect(0, 0, element.width, element.height)
    if (view.paused || view.switching || !latest.current) clear()
    const render = (now: number) => {
      if (now - lastPaint >= 100) {
        lastPaint = now
        const received = latest.current
        const status = !view.online ? '控制端离线 · 非实时画面'
          : view.paused ? '采集已暂停'
          : view.switching ? '正在切换阵列模式'
          : view.error ? `阵列采集异常：${view.error}`
          : !received ? '等待完整阵列帧'
          : now - received.receivedAt > 1000 ? '阵列数据超时 · 非实时画面' : ''
        setMessage(previous => previous === status ? previous : status)
        if (view.paused || view.switching) clear()
        else if (received && received.frame.sequence !== paintedSequence) {
          drawPressureMap(element, received.frame.values)
          paintedSequence = received.frame.sequence
        }
      }
      animation = requestAnimationFrame(render)
    }
    animation = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animation)
  }, [latest, view])

  return (
    <>
      <canvas ref={canvas} className={message ? 'heatmap-inactive' : ''} width={640} height={640}
        role="img" aria-label="64乘64模拟阵列，共4096个采集点" />
      {!message && <span className="cross">+</span>}
      {message && <span className="heatmap-message" role="status">{message}</span>}
    </>
  )
})
