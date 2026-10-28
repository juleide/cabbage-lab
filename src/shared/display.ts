import type { DisplayRange } from './controller'

/** Fixed UI track bounds; these must not depend on a saved/selected range. */
export const COLOR_RANGE_BOUNDS: Readonly<DisplayRange> = Object.freeze({ minimum: -4095, maximum: 4095 })

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

/** UI selection bounds are narrower than legacy stored configuration bounds. */
export function validateColorRange(value: unknown): DisplayRange {
  const range = validateDisplayRange(value)
  if (range.minimum < COLOR_RANGE_BOUNDS.minimum || range.maximum > COLOR_RANGE_BOUNDS.maximum) {
    throw new Error('显示范围须在 −4095～4095 之间，请在精确设置中调整或恢复默认')
  }
  return range
}
