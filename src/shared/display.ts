import type { DisplayRange } from './controller'

export const DEFAULT_DISPLAY_RANGE: DisplayRange = { minimum: 0, maximum: 4095 }

export function validateDisplayRange(value: unknown): DisplayRange {
  if (!value || typeof value !== 'object') throw new Error('显示范围无效')
  const { minimum, maximum } = value as DisplayRange
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)
    || minimum < -65535 || maximum > 65535 || minimum >= maximum) {
    throw new Error('上下限须在 −65535～65535 之间，且下限小于上限')
  }
  return { minimum, maximum }
}
