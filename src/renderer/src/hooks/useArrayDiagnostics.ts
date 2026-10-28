import { useEffect, useState } from 'react'
import type { PressureStatus } from '../../../shared/controller'

/** Diagnostic polling runs independently of the home canvas, at most once per second. */
export function useArrayDiagnostics(online: boolean) {
  const [status, setStatus] = useState<PressureStatus | null>(null)
  const [receiveFps, setReceiveFps] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const api = window.labDesktop
    if (!api || !online) { setReceiveFps(0); return }
    let live = true
    let pending = false
    let sequence = -1
    const received: number[] = []
    const unsubscribe = api.subscribe(event => {
      if (event.event === 'ready') { sequence = -1; received.length = 0 }
      if (event.event !== 'pressure.frame' || event.data.sequence <= sequence) return
      sequence = event.data.sequence
      if (Date.now() - Date.parse(event.data.capturedAt) > 1000) return
      const now = performance.now()
      received.push(now)
      while (received.length > 1 && now - received[0] > 1000) received.shift()
    })
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.request<PressureStatus>('pressure.status')
        if (!live) return
        setStatus(next)
        setError('')
        const now = performance.now()
        while (received.length && now - received[0] > 1000) received.shift()
        setReceiveFps(received.length)
      } catch (reason) { if (live) setError((reason as Error).message) }
      finally { pending = false }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1000)
    return () => { live = false; window.clearInterval(timer); unsubscribe() }
  }, [online])
  return { status, receiveFps, error }
}
