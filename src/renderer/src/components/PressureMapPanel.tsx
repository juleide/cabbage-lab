import { useRef } from 'react'
import { PressureHeatmap } from './PressureHeatmap'
import { usePressureArray } from '../hooks/usePressureArray'

export function PressureMapPanel() {
  const { latest, view, setMode } = usePressureArray()
  const mode = view.mode
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  return (
    <section className="panel map-panel">
      <div className="panel-head">
        <div className="panel-title">压力云图</div>
        <div className="mode-tabs" role="tablist" aria-label="压力云图模式">
          {(['press', 'grip'] as const).map((value, index) => (
            <button
              key={value}
              ref={element => { tabs.current[index] = element }}
              id={`mode-${value}`}
              className={mode === value ? 'active' : ''}
              role="tab"
              disabled={!view.online || view.switching}
              aria-selected={mode === value}
              aria-controls="pressure-map"
              tabIndex={mode === value ? 0 : -1}
              onClick={() => setMode(value)}
              onKeyDown={event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
                  setMode(next === 0 ? 'press' : 'grip')
                  tabs.current[next]?.focus()
                }
              }}
            >
              {value === 'press' ? '按压' : '抓取'}
            </button>
          ))}
        </div>
      </div>
      <div className="heat-area" id="pressure-map" role="tabpanel" aria-labelledby={`mode-${mode}`}>
        <div className="heatmap-stage">
          <div className="heat-wrap">
            <PressureHeatmap latest={latest} view={view} />
          </div>
        </div>
        <div className="scale"><span>0</span><div className="gradient" /><span>100</span></div>
        <div className="scale-label">相对强度 / % · 模拟阵列</div>
      </div>
    </section>
  )
}
