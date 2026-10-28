import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Theme } from '../domain/types'

const themes: { value: Theme; label: string }[] = [
  { value: 'light', label: '白色' }, { value: 'dark', label: '黑色' }, { value: 'blue', label: '科技蓝' }
]

export function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const label = themes.find(item => item.value === theme)!.label

  useEffect(() => { if (open) options.current[focusIndex]?.focus() }, [open, focusIndex])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function close() { setOpen(false); trigger.current?.focus() }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) { event.preventDefault(); close() }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (!open) {
      setFocusIndex(event.key === 'ArrowUp' || event.key === 'End' ? themes.length - 1 : 0)
      setOpen(true)
      return
    }
    setFocusIndex(index => event.key === 'Home' ? 0 : event.key === 'End' ? themes.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + themes.length) % themes.length)
  }

  return (
    <div className="theme-picker" ref={container} onKeyDown={onKeyDown}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <button className="theme-trigger" ref={trigger} type="button" aria-label={`主题设置：${label}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls="themeMenu"
        onClick={() => { setFocusIndex(themes.findIndex(item => item.value === theme)); setOpen(!open) }}>
        <svg className="theme-icon theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
        <svg className="theme-icon theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" /></svg>
        <svg className="theme-icon theme-tech" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /><path d="m10 12 2-2 2 2-2 2Z" /></svg>
        <span>{label}</span><svg className="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      <div className="theme-menu" id="themeMenu" role="menu" aria-label="主题设置" hidden={!open}>
        {themes.map((item, index) => (
          <button key={item.value} ref={element => { options.current[index] = element }}
            className="theme-option" type="button" role="menuitemradio" aria-checked={theme === item.value}
            tabIndex={-1} onFocus={() => setFocusIndex(index)} onClick={() => { onChange(item.value); close() }}>
            <span className={`theme-swatch ${item.value === 'light' ? '' : item.value}`} aria-hidden="true" />
            {item.label}<svg className="theme-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          </button>
        ))}
      </div>
    </div>
  )
}
