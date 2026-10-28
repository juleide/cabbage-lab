/** One palette for sampled pixels, the home legend, and the settings range selector. */
export const PRESSURE_PALETTE = [
  [234, 244, 237], [171, 215, 187], [95, 181, 139],
  [239, 219, 119], [235, 156, 81], [217, 99, 77]
] as const

export const PRESSURE_GRADIENT = `linear-gradient(90deg, ${PRESSURE_PALETTE.map(color => `rgb(${color.join(',')})`).join(', ')})`
