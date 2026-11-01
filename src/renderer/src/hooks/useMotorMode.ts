import { useEffect, useState } from 'react'
import type { useController } from './useController'
import { useMotorControl } from './useMotorControl'

// Legacy hook name retained for existing consumers; there is no mode switch.
export function useMotorMode(controller: ReturnType<typeof useController>) {
  const [authorized, setAuthorized] = useState(false)
  const motor = useMotorControl(controller, authorized)

  useEffect(() => {
    let live = true
    let revision = 0
    const api = window.labDesktop
    if (!api) return
    async function status() {
      const version = revision
      try {
        const value = await api!.getDeviceDebugAuth()
        if (live && version === revision) setAuthorized(value.authorized)
      } catch { if (live && version === revision) setAuthorized(false) }
    }
    const unsubscribe = api.onDeviceDebugLocked(() => { revision++; if (live) setAuthorized(false) })
    void status()
    const timer = setInterval(() => void status(), 1000)
    return () => { live = false; clearInterval(timer); unsubscribe() }
  }, [])

  async function login(username: string, password: string) {
    try {
      if (!window.labDesktop) throw new Error('请使用 Electron')
      const result = await window.labDesktop.loginDeviceDebug(username, password)
      setAuthorized(result.authorized)
      if (!result.authorized) throw new Error(result.message || '验证失败')
      return true
    } catch (reason) { controller.notify((reason as Error).message); return false }
  }
  return { ...motor, authorized, switching: false, login }
}
