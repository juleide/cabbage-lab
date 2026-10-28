import type { MapMode } from '../domain/types.ts'

const palette = [[234, 244, 237], [171, 215, 187], [95, 181, 139], [239, 219, 119], [235, 156, 81], [217, 99, 77]]
const GRID_SIZE = 64

export function pressureAt(x: number, y: number, mode: MapMode, tick: number, active: boolean): number {
  if (!active) return 0
  const mid = (GRID_SIZE - 1) / 2
  const nx = (x - mid) / mid
  const ny = (y - mid) / mid
  let value = mode === 'press'
    ? Math.exp(-((nx + 0.06) ** 2 / 0.31 + (ny - 0.07) ** 2 / 0.47)) * 0.88 + Math.exp(-((nx - 0.22) ** 2 / 0.055 + (ny + 0.22) ** 2 / 0.09)) * 0.16
    : (Math.exp(-((nx + 0.4) ** 2 / 0.07 + ny ** 2 / 0.4)) + Math.exp(-((nx - 0.4) ** 2 / 0.07 + ny ** 2 / 0.4))) * 0.85
  value += Math.sin(tick * 0.05) * 0.025 + Math.sin(x * 2.3 + y * 1.8) * 0.018
  return Math.max(0, Math.min(0.99, value))
}

export function drawPressureMap(canvas: HTMLCanvasElement, mode: MapMode, tick: number, active: boolean) {
  const context = canvas.getContext('2d')
  if (!context) return
  const cell = canvas.width / GRID_SIZE
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const key = pressureAt(x, y, mode, tick, active) * 5
      const index = Math.min(4, Math.floor(key))
      const fraction = key - index
      const color = palette[index].map((value, channel) => Math.round(value * (1 - fraction) + palette[index + 1][channel] * fraction))
      context.fillStyle = `rgb(${color.join(',')})`
      context.fillRect(x * cell, y * cell, cell - 1, cell - 1)
    }
  }
}
