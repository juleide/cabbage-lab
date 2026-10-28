import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapMode, PressureFrame, PressureStatus, Snapshot } from '../../../shared/controller'

export interface ReceivedPressureFrame {
  frame: PressureFrame
  receivedAt: number
}
export interface PressureView extends PressureStatus {
  online: boolean
  switching: boolean
}

function validFrame(frame: PressureFrame) {
  return frame.width === 64 && frame.height === 64 && frame.source === 'simulation'
    && frame.values.length === 4096 && frame.values.every(value => Number.isInteger(value) && value >= 0 && value <= 65535)
}

/** Frames never enter React state: telemetry updates only this bounded, latest-value ref. */
export function usePressureArray() {
  const latest = useRef<ReceivedPressureFrame | null>(null)
  const control = useRef<PressureView>({ mode: 'press', generation: 0, paused: false, error: null, online: false, switching: false })
  const [view, setView] = useState(control.current)
  const update = useCallback((next: PressureView) => {
    const previous = control.current
    if (previous.mode !== next.mode || previous.generation !== next.generation) latest.current = null
    control.current = next
    if (Object.keys(next).some(key => previous[key as keyof PressureView] !== next[key as keyof PressureView])) setView(next)
  }, [])

  useEffect(() => {
    const api = window.labDesktop
    if (!api) return
    let live = true
    let lifecycle = 0
    let receivedState = false
    const accept = (frame: PressureFrame | null) => {
      const status = control.current
      if (!frame || !validFrame(frame) || status.switching || status.paused || !status.online) return
      if (frame.mode !== status.mode || frame.generation !== status.generation) return
      if (latest.current && frame.sequence <= latest.current.frame.sequence) return
      const capturedAt = Date.parse(frame.capturedAt)
      if (!Number.isFinite(capturedAt)) return
      // A delayed IPC event must not make an old capture appear live after a renderer stall.
      latest.current = { frame, receivedAt: performance.now() - Math.max(0, Date.now() - capturedAt) }
    }
    const restore = (snapshot: Snapshot) => {
      latest.current = null
      update({ ...snapshot.state.array, online: true, switching: false })
      accept(snapshot.pressureFrame)
    }
    const unsubscribe = api.subscribe(event => {
      if (!live) return
      switch (event.event) {
        case 'ready': lifecycle++; receivedState = true; restore(event.data); break
        case 'offline': lifecycle++; update({ ...control.current, online: false, switching: false }); break
        case 'state':
          receivedState = true
          update({ ...event.data.array, online: true, switching: control.current.switching })
          break
        case 'pressure.frame': accept(event.data); break
      }
    })
    void api.request<Snapshot>('state.get').then(snapshot => {
      if (!live || lifecycle !== 0) return
      if (!receivedState) restore(snapshot)
      else accept(snapshot.pressureFrame)
    }).catch(() => {})
    return () => { live = false; unsubscribe() }
  }, [update])

  const setMode = useCallback(async (mode: MapMode) => {
    if (!window.labDesktop || !control.current.online || control.current.switching || mode === control.current.mode) return
    latest.current = null
    update({ ...control.current, switching: true, error: null })
    try {
      const status = await window.labDesktop.request<PressureStatus>('pressure.mode', { mode })
      update({ ...status, online: control.current.online, switching: false })
    } catch (reason) {
      update({ ...control.current, switching: false, error: (reason as Error).message })
    }
  }, [update])

  return { latest, view, setMode }
}
