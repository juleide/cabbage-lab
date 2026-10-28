import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { DisplayRange } from '../../../../shared/controller'
import { COLOR_RANGE_BOUNDS } from '../../../../shared/display'
import { PRESSURE_PALETTE } from '../../graphics/palette'

export function formatRangeValue(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.000001) return value.toExponential(3)
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

type Endpoint = keyof DisplayRange
interface Props {
  value: DisplayRange
  disabled: boolean
  onChange: (value: DisplayRange) => void
}
interface Drag { endpoint: Endpoint; pointerId: number; grabOffset: number }

export function ColorRangeSelector({ value, disabled, onChange }: Props) {
  const descriptionId = useId()
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef<Drag | null>(null)
  const current = useRef(value)
  const [active, setActive] = useState<Endpoint | null>(null)
  current.current = value
  const domain = COLOR_RANGE_BOUNDS
  const span = domain.maximum - domain.minimum
  const step = 1
  const clamp = (number: number) => Math.max(domain.minimum, Math.min(domain.maximum, number))
  const percentage = (number: number) => Math.max(0, Math.min(100, (number - domain.minimum) / span * 100))
  const lower = percentage(value.minimum)
  const upper = percentage(value.maximum)
  const stops = PRESSURE_PALETTE.map((color, index) => `rgb(${color.join(',')}) ${lower + (upper - lower) * index / (PRESSURE_PALETTE.length - 1)}%`)
  const background = `linear-gradient(90deg, rgb(${PRESSURE_PALETTE[0].join(',')}) 0%, ${stops.join(', ')}, rgb(${PRESSURE_PALETTE[5].join(',')}) 100%)`

  function change(endpoint: Endpoint, candidate: number) {
    if (disabled) return
    const previous = current.current
    const gap = Math.min(step, previous.maximum - previous.minimum)
    const minimum = endpoint === 'minimum' ? domain.minimum : Math.max(domain.minimum, previous.minimum + gap)
    const maximum = endpoint === 'maximum' ? domain.maximum : Math.min(domain.maximum, previous.maximum - gap)
    if (minimum > maximum) return
    const rounded = Number(Math.max(minimum, Math.min(maximum, candidate)).toPrecision(12))
    const next = { ...previous, [endpoint]: Math.max(minimum, Math.min(maximum, rounded)) }
    if (!Number.isFinite(next.minimum) || !Number.isFinite(next.maximum) || next.minimum >= next.maximum) return
    current.current = next
    onChange(next)
  }

  function start(event: PointerEvent<HTMLButtonElement>, endpoint: Endpoint) {
    if (disabled || dragging.current || event.button !== 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    dragging.current = { endpoint, pointerId: event.pointerId, grabOffset: event.clientX - bounds.left - bounds.width / 2 }
    setActive(endpoint)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragging.current
    if (!drag || drag.pointerId !== event.pointerId || !track.current) return
    const bounds = track.current.getBoundingClientRect()
    if (!bounds.width) return
    const fraction = Math.max(0, Math.min(1, (event.clientX - drag.grabOffset - bounds.left) / bounds.width))
    change(drag.endpoint, Math.round(domain.minimum + fraction * span))
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    if (dragging.current?.pointerId !== event.pointerId) return
    dragging.current = null
    setActive(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, endpoint: Endpoint) {
    let candidate = current.current[endpoint]
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowDown': candidate -= step; break
      case 'ArrowRight': case 'ArrowUp': candidate += step; break
      case 'PageDown': candidate -= step * 10; break
      case 'PageUp': candidate += step * 10; break
      case 'Home': candidate = domain.minimum; break
      case 'End': candidate = domain.maximum; break
      default: return
    }
    event.preventDefault()
    change(endpoint, candidate)
  }

  return (
    <div className={`color-range${disabled ? ' color-range--disabled' : ''}`}>
      <div className="color-range-values">
        <div><span className="color-range-label">显示下限</span><output title={String(value.minimum)}>{formatRangeValue(value.minimum)}</output><small>低值颜色从这里开始</small></div>
        <div><span className="color-range-label">显示上限</span><output title={String(value.maximum)}>{formatRangeValue(value.maximum)}</output><small>达到这里显示为红色</small></div>
      </div>
      <div className="color-range-track" ref={track}>
        <div className="color-range-band" style={{ background }} aria-hidden="true" />
        {(['minimum', 'maximum'] as const).map(endpoint => (
          <button key={endpoint} type="button" role="slider" disabled={disabled}
            className={`color-range-thumb color-range-thumb--${endpoint}${active === endpoint ? ' is-dragging' : ''}`}
            style={{ left: `${endpoint === 'minimum' ? lower : upper}%` }}
            aria-label={endpoint === 'minimum' ? '显示下限' : '显示上限'} aria-describedby={descriptionId}
            aria-valuemin={endpoint === 'minimum' ? domain.minimum : clamp(value.minimum)}
            aria-valuemax={endpoint === 'maximum' ? domain.maximum : clamp(value.maximum)}
            aria-valuenow={clamp(value[endpoint])} aria-valuetext={String(value[endpoint])}
            onPointerDown={event => start(event, endpoint)} onPointerMove={move}
            onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
            onKeyDown={event => keyDown(event, endpoint)}>
            <span className="color-range-grip" aria-hidden="true"><i /><i /></span>
          </button>
        ))}
      </div>
      <div className="color-range-scale" aria-hidden="true"><span>{formatRangeValue(domain.minimum)}</span><span>{formatRangeValue(domain.maximum)}</span></div>
      <p className="color-range-instruction" id={descriptionId}>拖动上方的下限手柄或下方的上限手柄，方向键每次微调 1。刻度固定为 −4095～4095。</p>
    </div>
  )
}
