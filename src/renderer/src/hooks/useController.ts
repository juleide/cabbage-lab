import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppInfo, ControllerMethod, DeviceCommand, LabConfig, LabState, LogEntry, Snapshot
} from '../../../shared/controller'

export function useController() {
  const [state, setState] = useState<LabState | null>(null)
  const [config, setConfig] = useState<LabConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ sequence: 0, message: '' })
  const actions = useRef(new Set<string>())
  const pressure = useRef<number | null>(null)
  const flushing = useRef<Promise<void> | null>(null)
  const notify = useCallback((message: string) => {
    setNotice(previous => ({ sequence: previous.sequence + 1, message }))
  }, [])

  const request = useCallback(<T,>(method: ControllerMethod, params: Record<string, unknown> = {}) => {
    if (!window.labDesktop) return Promise.reject<T>(new Error('请通过 Electron 启动，浏览器模式没有 Python 控制端'))
    return window.labDesktop.request<T>(method, params)
  }, [])

  useEffect(() => {
    const api = window.labDesktop
    if (!api) { setError('浏览器预览不连接设备，请使用 Electron 应用'); return }
    let live = true
    let revision = 0
    let epoch = 0
    const apply = (snapshot: Snapshot) => {
      setState(snapshot.state)
      setConfig(snapshot.config)
      setConfigError(snapshot.configError)
      setLogs(snapshot.logs)
      setOnline(true)
      setError('')
    }
    const unsubscribe = api.subscribe(event => {
      if (!live) return
      revision++
      switch (event.event) {
        case 'ready': epoch++; apply(event.data); break
        case 'state': setState(event.data); setOnline(true); setError(''); break
        case 'config': setConfig(event.data); setConfigError(null); break
        case 'log': setLogs(previous => [event.data, ...previous].slice(0, 200)); break
        case 'offline': epoch++; setOnline(false); setError(event.data.message); break
      }
    })
    // Subscribe before the initial snapshot so ready/state events cannot be missed.
    api.request<Snapshot>('state.get').then(snapshot => {
      if (!live || epoch !== 0) return
      if (revision === 0) apply(snapshot)
      else {
        // Reloading a renderer may receive telemetry before the snapshot response.
        // Keep that newer state, but still restore config and historical logs.
        setConfig(current => current || snapshot.config)
        setConfigError(snapshot.configError)
        setLogs(current => {
          const entries = new Map([...snapshot.logs, ...current].map(entry => [entry.time + entry.message, entry]))
          return [...entries.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, 200)
        })
      }
    }).catch(reason => {
      if (live && revision === 0) setError(String(reason.message || reason))
    })
    api.info().then(value => { if (live) setInfo(value) }).catch(() => {})
    return () => { live = false; unsubscribe() }
  }, [])

  const send = useCallback(async (command: DeviceCommand): Promise<boolean> => {
    if (!online) { notify('控制端离线，设备状态未知，请到设置页检查'); return false }
    if (command.type === 'pressure') {
      // Keep only the newest slider value; do not flood the command queue while dragging.
      pressure.current = command.value
      if (!flushing.current) {
        flushing.current = (async () => {
          try {
            while (pressure.current !== null) {
              const value = pressure.current
              pressure.current = null
              await request('device.command', { type: 'pressure', value })
            }
          } catch (reason) { pressure.current = null; notify((reason as Error).message) }
          finally { flushing.current = null }
        })()
      }
      await flushing.current
      return true
    }
    const key = command.type === 'toggle' ? `toggle:${command.device}` : command.type
    if (actions.current.has(key)) return false
    actions.current.add(key)
    setBusy(true)
    try {
      if (command.type === 'commitPressure') await flushing.current
      const result = await request<{ message: string }>('device.command', { ...command })
      if (result.message) notify(result.message)
      return true
    } catch (reason) {
      notify((reason as Error).message)
      return false
    } finally {
      actions.current.delete(key)
      setBusy(actions.current.size > 0)
    }
  }, [online, notify, request])

  const restart = useCallback(async () => {
    if (!window.labDesktop) return
    setBusy(true)
    try {
      await window.labDesktop.restartController()
      notify('控制端已重启，设备保持待机')
    } catch (reason) { notify((reason as Error).message) }
    finally { setBusy(false) }
  }, [notify])

  return { state, config, configError, logs, info, online, error, busy, notice, notify, request, send, restart }
}
