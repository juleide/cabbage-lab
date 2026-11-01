import { useCallback, useEffect, useRef, useState } from 'react'
import type { useController } from './useController'
import type { MotorControlStatus, MotorTarget } from '../../../shared/hardware'

export const motorSessionActive = (status: MotorControlStatus | null) => !!status && ['connecting', 'monitoring', 'disconnecting'].includes(status.state)

export function useMotorControl(controller: ReturnType<typeof useController>, unlocked: boolean) {
  const { online, request } = controller
  const [status, setStatus] = useState<MotorControlStatus | null>(null)
  const [known, setKnown] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const mounted = useRef(true)
  const preparing = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++ } }, [])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKnown(false)
    if (!online || !unlocked) return
    async function poll() {
      const version = revision.current
      try {
        const value = await request<MotorControlStatus | null>('hardware.motor.status')
        if (live && version === revision.current) { setStatus(value); setKnown(true) }
      } catch (reason) {
        if (live && version === revision.current) { setKnown(false); setError((reason as Error).message) }
      } finally { if (live) timer = setTimeout(() => void poll(), 300) }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [online, unlocked, request])

  const operate = useCallback(async (operation: 'connect' | 'start' | 'stop' | 'disconnect', target?: MotorTarget, emergency = false) => {
    const preparation = operation === 'connect' || operation === 'start'
    if (!online || (preparation && (!unlocked || preparing.current))) return false
    if (preparation) preparing.current = true
    const version = ++revision.current
    setPending(true); setError('')
    const params = operation === 'start' ? { target, sessionId: status?.sessionId, configVersion: status?.configVersion }
      : operation === 'stop' ? { target: target ?? null, emergency } : {}
    try {
      const value = await request<MotorControlStatus>(`hardware.motor.${operation}`, params)
      if (mounted.current && version === revision.current) { setStatus(value); setKnown(true) }
      return true
    } catch (reason) {
      if (mounted.current && version === revision.current) { setError((reason as Error).message); setKnown(false) }
      return false
    } finally {
      if (preparation) preparing.current = false
      if (mounted.current && version === revision.current) { revision.current++; setPending(false) }
    }
  }, [online, unlocked, request, status?.sessionId, status?.configVersion])

  // A stop must be offered even before a pending connect has returned its
  // first session snapshot; the IPC barrier can invalidate that connection.
  return { status, known: known && online && unlocked, pending, error, operate, active: motorSessionActive(status) || pending }
}
