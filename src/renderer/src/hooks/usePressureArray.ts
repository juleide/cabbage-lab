import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapMode, PressureFrame, PressureStatus, Snapshot } from '../../../shared/controller'

export interface ReceivedPressureFrame { frame: PressureFrame; receivedAt: number }
export interface PressureView extends PressureStatus { online: boolean; switching: boolean }
const initial: PressureView = {
  mode: 'press', generation: 0, paused: false, error: null, online: false, switching: false,
  processingVersion: 0,
  correction: { active: false, collecting: false, collected: 0, target: 25, appliedAt: null, error: null },
  diagnostics: { validFrames: 0, crcErrors: 0, droppedFrames: 0, duplicateRows: 0, captureFps: 0, lastFrameAt: null }
}

function validFrame(frame: PressureFrame) {
  return frame.width === 64 && frame.height === 64 && frame.source === 'simulation'
    && Array.isArray(frame.values) && frame.values.length === 4096 && frame.values.every(value => Number.isInteger(value) && value >= 0 && value <= 65535)
    && Array.isArray(frame.displayValues) && frame.displayValues.length === 4096 && frame.displayValues.every(Number.isFinite)
}

/** Raw/display arrays stay in a ref, not application-wide React state. */
export function usePressureArray() {
  const latest = useRef<ReceivedPressureFrame | null>(null)
  const control = useRef(initial)
  const [view, setView] = useState(initial)
  const update = useCallback((next: PressureView) => {
    if (!next.correction || !next.diagnostics || !Number.isInteger(next.processingVersion)) {
      next = { ...initial, online: next.online, error: '阵列协议已更新，请重启应用' }
    }
    const previous = control.current
    if (previous.generation !== next.generation || previous.processingVersion !== next.processingVersion) latest.current = null
    control.current = next
    if (JSON.stringify(previous) !== JSON.stringify(next)) setView(next)
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
      if (frame.mode !== status.mode || frame.generation !== status.generation || frame.processingVersion !== status.processingVersion) return
      if (latest.current && frame.sequence <= latest.current.frame.sequence) return
      const capturedAt = Date.parse(frame.capturedAt)
      if (Number.isFinite(capturedAt)) latest.current = { frame, receivedAt: performance.now() - Math.max(0, Date.now() - capturedAt) }
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

  const operation = useCallback(async (method: 'pressure.mode' | 'pressure.zero.start' | 'pressure.zero.clear', params = {}) => {
    if (!window.labDesktop || !control.current.online || control.current.switching) return
    update({ ...control.current, switching: true, error: null })
    try {
      const status = await window.labDesktop.request<PressureStatus>(method, params)
      update({ ...status, online: control.current.online, switching: false })
    } catch (reason) { update({ ...control.current, switching: false }); throw reason }
  }, [update])
  const setMode = useCallback((mode: MapMode) => {
    if (mode !== control.current.mode) return operation('pressure.mode', { mode })
  }, [operation])
  return { latest, view, setMode, operation }
}
