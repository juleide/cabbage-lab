import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DeviceAuthState } from '../../../../shared/device-auth'
import { Modal } from '../Modal'
import '../../styles/device-auth.css'

export function DeviceDebugGate({ children, onUnlocked }: {
  onUnlocked: () => void
  children: (authorized: boolean, open: () => void) => ReactNode
}) {
  const [auth, setAuth] = useState<DeviceAuthState | null>(null)
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [dialog, setDialog] = useState(false)
  const authorized = useRef(false)
  const alive = useRef(true)
  const attempt = useRef(0)
  const authEpoch = useRef(0)
  const passwordInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    alive.current = true
    const api = window.labDesktop
    if (!api) { setMessage('请通过 Electron 应用进行研发身份验证'); return }
    const apply = (state: DeviceAuthState) => {
      if (!alive.current) return
      if (authorized.current && !state.authorized) {
        setMessage('工程权限已锁定，请重新验证。未保存草稿仍保留在当前页面。')
        setPassword(''); setVisible(false)
      }
      authorized.current = state.authorized
      if (state.authorized) setDialog(false)
      setAuth(state)
    }
    const status = () => {
      const epoch = authEpoch.current
      return api.getDeviceDebugAuth().then(state => {
        if (epoch === authEpoch.current) apply(state)
      }).catch(() => {
        if (!alive.current || epoch !== authEpoch.current) return
        authorized.current = false
        setAuth(null); setMessage('无法读取认证状态，请稍后重试')
      })
    }
    const unsubscribe = api.onDeviceDebugLocked(() => {
      if (!alive.current) return
      // Hide settings immediately rather than waiting for the status round-trip.
      authEpoch.current++
      const wasAuthorized = authorized.current
      authorized.current = false
      setAuth(current => current ? { ...current, authorized: false } : current)
      if (wasAuthorized) {
        setMessage('工程权限已锁定，请重新验证。未保存草稿仍保留在当前页面。')
        setPassword(''); setVisible(false)
      }
      void status()
    })
    void status()
    const timer = setInterval(() => { void status() }, 1000)
    return () => {
      alive.current = false; attempt.current++
      clearInterval(timer); unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!auth?.authorized) return
    let last = -Infinity
    const activity = (event: Event) => {
      if (!event.isTrusted || performance.now() - last < 5000) return
      last = performance.now()
      void window.labDesktop?.touchDeviceDebug().then(state => {
        if (!alive.current || state.authorized) return
        authorized.current = false
        setAuth(state)
        setMessage('工程权限已过期，请重新验证')
      }).catch(() => {
        if (!alive.current) return
        authorized.current = false
        setAuth(null); setMessage('认证服务不可用，请重新验证')
      })
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    for (const name of events) window.addEventListener(name, activity, { passive: true })
    return () => { for (const name of events) window.removeEventListener(name, activity) }
  }, [auth?.authorized])

  async function login() {
    const api = window.labDesktop
    if (!api || busy) return
    const id = ++attempt.current
    authEpoch.current++
    setBusy(true); setMessage('')
    // Only the pending request retains the submitted password.
    const submitted = password
    setPassword(''); setVisible(false)
    try {
      const response = await api.loginDeviceDebug(submitted)
      const result = response.authorized ? { ...response, ...await api.getDeviceDebugAuth() } : response
      if (!alive.current || id !== attempt.current) return
      authorized.current = result.authorized
      setAuth(result)
      setMessage(result.message || '')
      if (result.authorized) { setDialog(false); onUnlocked() }
      else requestAnimationFrame(() => passwordInput.current?.focus())
    } catch {
      if (alive.current) setMessage('验证服务暂不可用，请稍后重试')
    } finally { if (alive.current && id === attempt.current) setBusy(false) }
  }

  return <>
    {children(!!auth?.authorized, () => { setMessage(''); setPassword(''); setVisible(false); setDialog(true) })}
    {dialog && <Modal title="工程模式" onClose={() => { if (!busy) { setDialog(false); setPassword(''); setVisible(false) } }}>
      <div className="device-auth-card">
        <form onSubmit={event => { event.preventDefault(); void login() }}>
          <label htmlFor="device-debug-password">密码</label>
          <div className="device-auth-password"><input autoFocus id="device-debug-password" ref={passwordInput} type={visible ? 'text' : 'password'} autoComplete="new-password" required maxLength={1024} value={password} placeholder="请输入工程模式密码" disabled={busy} onChange={event => setPassword(event.target.value)} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} disabled={busy} onClick={() => setVisible(value => !value)}>{visible ? '隐藏' : '显示'}</button></div>
          {(!auth || !auth.configured || message || !!auth.retryAfterSeconds) && <p className="device-auth-message" role="status">{auth && !auth.configured ? '未配置工程模式密码，请联系管理员' : auth?.retryAfterSeconds ? `尝试次数过多，请 ${auth.retryAfterSeconds} 秒后重试` : message || '正在读取认证状态…'}</p>}
          <button className="device-auth-submit" type="submit" disabled={busy || !auth?.configured || !!auth?.retryAfterSeconds || !password}>{busy ? '验证中…' : '进入'}</button>
          <button className="btn" type="button" disabled={busy} onClick={() => { setDialog(false); setPassword(''); setVisible(false) }}>取消</button>
        </form>
      </div>
    </Modal>}
  </>
}
