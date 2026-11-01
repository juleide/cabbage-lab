import type { DisplayRange } from '../../../shared/controller'
import { DEFAULT_DISPLAY_RANGE } from '../../../shared/display.ts'

import { PRESSURE_PALETTE as PALETTE } from './palette.ts'
export const GRID_SIZE = 64

export function pressureColor(value: number, range: DisplayRange = DEFAULT_DISPLAY_RANGE): number[] {
  const key = Math.max(0, Math.min(1, (value - range.minimum) / (range.maximum - range.minimum))) * (PALETTE.length - 1)
  const index = Math.min(PALETTE.length - 2, Math.floor(key))
  const fraction = key - index
  return PALETTE[index].map((channel, number) => Math.round(channel * (1 - fraction) + PALETTE[index + 1][number] * fraction))
}

/** The array is row-major and already reordered by Python. No distribution is synthesized here. */
export function drawPressureMap(canvas: HTMLCanvasElement, values: readonly number[], range: DisplayRange = DEFAULT_DISPLAY_RANGE) {
  if (values.length !== GRID_SIZE * GRID_SIZE) return
  const context = canvas.getContext('2d')
  if (!context) return
  const cellX = canvas.width / GRID_SIZE
  const cellY = canvas.height / GRID_SIZE
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      context.fillStyle = `rgb(${pressureColor(values[y * GRID_SIZE + x], range).join(',')})`
      context.fillRect(x * cellX, y * cellY, cellX - 1, cellY - 1)
    }
  }
}
