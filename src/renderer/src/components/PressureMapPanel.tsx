import { useCallback, useEffect, useRef, useState } from 'react'
import { PRESSURE_GRADIENT } from '../graphics/palette'
import type { DisplayRange, MapMode } from '../../../shared/controller'
import { PressureHeatmap } from './PressureHeatmap'
import type { FrameReadout, SelectedPoint } from './PressureHeatmap'
import { usePressureArray } from '../hooks/usePressureArray'
import { PressureDetailsDialog } from '../dialogs/PressureDetailsDialog'

export function PressureMapPanel({ range, idle, notify, onEmergency }: { range: DisplayRange; idle: boolean; notify: (message: string) => void; onEmergency: () => void }) {
  const { latest, view, setMode, operation } = usePressureArray()
  const [selected, setSelected] = useState<SelectedPoint | null>(null)
  const [details, setDetails] = useState(false)
  const [reading, setReading] = useState<{ frame: FrameReadout | null; status: string }>({ frame: null, status: '等待完整阵列帧' })
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => { setSelected(null) }, [view.mode])
  const onReadout = useCallback((frame: FrameReadout | null, status: string) => {
    setReading(previous => previous.frame === frame && previous.status === status ? previous : { frame, status })
  }, [])
  function selectMode(mode: MapMode) { void Promise.resolve(setMode(mode)).catch(reason => notify(reason.message)) }
  async function correct(start: boolean) {
    if (start && !window.confirm('请确认传感器已卸载负载。将采集 25 个完整原始帧作为零点参考，是否继续？')) return
    try { await operation(start ? 'pressure.zero.start' : 'pressure.zero.clear') }
    catch (reason) { notify((reason as Error).message) }
  }
  const heatmap = <PressureHeatmap latest={latest} view={view} range={range} selected={selected} onSelect={setSelected} onReadout={onReadout} />
  const point = reading.frame?.point
  return (
    <section className="panel map-panel">
      <div className="panel-head">
        <div className="map-title"><span className="panel-title">压力云图</span>
          <button className="map-details-entry" aria-label="云图详情" title="云图详情" onClick={() => setDetails(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8l-5-5m13 5 5-5M8 16l-5 5m13-5 5 5" /></svg></button>
        </div>
        <div className="mode-tabs" role="tablist" aria-label="压力云图模式">
          {(['press', 'grip'] as const).map((mode, index) => (
            <button key={mode} ref={element => { tabs.current[index] = element }} id={`mode-${mode}`} className={view.mode === mode ? 'active' : ''}
              role="tab" disabled={!view.online || view.switching} aria-selected={view.mode === mode} aria-controls="pressure-map" tabIndex={view.mode === mode ? 0 : -1}
              onClick={() => selectMode(mode)} onKeyDown={event => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
                  selectMode(next === 0 ? 'press' : 'grip')
                  tabs.current[next]?.focus()
                }
              }}>{mode === 'press' ? '按压' : '抓取'}</button>
          ))}
        </div>
      </div>
      <div className="heat-area" id="pressure-map" role="tabpanel" aria-labelledby={`mode-${view.mode}`}>
        <div className="heatmap-stage"><div className="heat-wrap">{!details && heatmap}</div></div>
        <div className="scale"><span>{range.minimum}</span><div className="gradient" style={{ background: PRESSURE_GRADIENT }} /><span>{range.maximum}</span></div>
        <div className="scale-label map-point-readout">{selected && point ? `${selected.row + 1}行 ${selected.column + 1}列 · 原始 ${point.raw.toFixed(0)} / 修正 ${point.display.toFixed(2)}` : `${view.correction.active ? '修正值' : '原始值'} · 模拟阵列 · 点击查看点位`}{reading.status && <small>非实时</small>}</div>
      </div>
      {details && <PressureDetailsDialog view={view} readout={reading.frame} stale={reading.status} selected={selected} idle={idle}
        onEmergency={onEmergency} onStart={() => { void correct(true) }} onClear={() => { void correct(false) }} onClose={() => setDetails(false)}>
        <div className="heat-wrap">{heatmap}</div>
      </PressureDetailsDialog>}
    </section>
  )
}
