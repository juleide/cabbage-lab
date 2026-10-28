const PALETTE = [[234, 244, 237], [171, 215, 187], [95, 181, 139], [239, 219, 119], [235, 156, 81], [217, 99, 77]]
export const GRID_SIZE = 64
export const SIMULATION_MAX = 4095

export function pressureColor(value: number, maximum = SIMULATION_MAX): number[] {
  const key = Math.max(0, Math.min(1, value / maximum)) * (PALETTE.length - 1)
  const index = Math.min(PALETTE.length - 2, Math.floor(key))
  const fraction = key - index
  return PALETTE[index].map((channel, number) => Math.round(channel * (1 - fraction) + PALETTE[index + 1][number] * fraction))
}

/** The array is row-major and already reordered by Python. No distribution is synthesized here. */
export function drawPressureMap(canvas: HTMLCanvasElement, values: readonly number[]) {
  if (values.length !== GRID_SIZE * GRID_SIZE) return
  const context = canvas.getContext('2d')
  if (!context) return
  const cellX = canvas.width / GRID_SIZE
  const cellY = canvas.height / GRID_SIZE
  context.clearRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      context.fillStyle = `rgb(${pressureColor(values[y * GRID_SIZE + x]).join(',')})`
      context.fillRect(x * cellX, y * cellY, cellX - 1, cellY - 1)
    }
  }
}
