import { memo, useEffect, useRef } from 'react'
import type { MapMode } from '../domain/types'
import { drawPressureMap } from '../graphics/pressureMap'

export const PressureHeatmap = memo(function PressureHeatmap({ mode, frame, active }: { mode: MapMode; frame: number; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (canvas.current) drawPressureMap(canvas.current, mode, frame * 3, active)
  }, [mode, frame, active])
  return <canvas ref={canvas} width={640} height={640} role="img" aria-label="64乘64模拟压力阵列，共4096个点" />
})
