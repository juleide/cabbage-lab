import { useEffect, useRef, useState } from 'react'
import type { useController } from '../../hooks/useController'
import type { MotionSection, MotionStatuses } from '../../../../shared/hardware'

const labels = { motors: '电机总线', lift: '升降装置' }
const states = { connecting: '连接中', monitoring: '诊断监听中', disconnecting: '停止并断开中', disconnected: '已断开', failed: '诊断故障' }
const results = { queued: '停止已排队', acknowledged: '收到停止回显，机械停止未确认', sent: '停止已发送，无 ACK，机械停止未确认', unknown: '停止结果未知，请现场确认' }
const active = (state?: string) => ['connecting', 'monitoring', 'disconnecting'].includes(state || '')

export function MotionConnections({ controller, unlocked, disabled, visible, onActive }: {
  controller: ReturnType<typeof useController>; unlocked: boolean; disabled: boolean; visible: boolean
  onActive: (value: boolean) => void
}) {
  const { request, online } = controller
  const [statuses, setStatuses] = useState<MotionStatuses>({})
  const [known, setKnown] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKnown(false)
    if (!online || !unlocked) return
    async function poll() {
      const version = revision.current
      try {
        const value = await request<MotionStatuses>('hardware.motion.status')
        if (live && version === revision.current) {
          setStatuses(value); setKnown(true)
          onActive(Object.values(value).some(status => active(status?.state)))
        }
      } catch (reason) {
        if (live && version === revision.current) { setKnown(false); setError((reason as Error).message) }
      } finally { if (live) timer = setTimeout(() => void poll(), 500) }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [online, unlocked, request, onActive])

  async function operate(section: MotionSection, operation: 'connect' | 'stop' | 'disconnect', emergency = false) {
    if (!online || !unlocked || (pending && operation === 'connect')) return
    if (operation === 'connect' && !window.confirm('将打开真实执行机构串口。电机仅查询两个站号的状态，升降仅监听 RS232；连接不发送启动、使能或清错。之后点击停止/断开、权限锁定或退出时会发送停止指令，但不能保证机械停止。请确认硬接线急停和现场安全。是否继续？')) return
    setPending(true); setError('')
    const version = ++revision.current
    try {
      const value = await request<MotionStatuses>(`hardware.motion.${operation}`, { section, ...(operation === 'stop' ? { emergency } : {}) })
      if (mounted.current && version === revision.current) {
        setStatuses(value); setKnown(true)
        onActive(Object.values(value).some(status => active(status?.state)))
      }
    } catch (reason) { if (mounted.current && version === revision.current) setError((reason as Error).message) }
    finally { if (version === revision.current) { revision.current++; if (mounted.current) setPending(false) } }
  }

  return <section className="hw-sensor-panel" hidden={!visible} aria-label="真实执行机构诊断">
    <h3>真实执行机构状态与停止诊断</h3>
    <p className="hw-note">仅支持电机状态查询、停止/软件急停及升降 RS232 38400/8N1 监听/停止。不开放启动、使能、释放、回零、上升或下降。停止回显不等于机械停止；升降高度不是已停反馈。断开会先尽力发送停止，权限锁定、休眠和退出也会请求停止并断开，不自动重连。</p>
    {error && <p className="settings-warning" role="alert">{error}</p>}
    <div className="hw-grid">{(['motors', 'lift'] as const).map(section => {
      const status = statuses[section]
      const connected = active(status?.state)
      return <article className="hw-box" key={section} aria-label={`${labels[section]}真实诊断`}>
        <h4>{labels[section]}<span>{!online || !known ? '状态未知' : status ? states[status.state] : '未连接'}</span></h4>
        {status && <p className="hw-note">会话 {status.sessionId.slice(0, 8)} · 配置 {status.configVersion.slice(0, 12)} · {status.faultLatched ? '故障/软件急停已锁存（不自动清错）' : '未锁存故障不等于允许运动'}</p>}
        {status?.error && <p className="settings-warning">{status.error}</p>}
        {!!status?.auditDropped && <p className="settings-warning">审计缓冲溢出，缺失 {status.auditDropped} 条，不能视为完整操作记录。</p>}
        {status && !Object.keys(status.readings).length && <p className="hw-note">未收到有效反馈；端口打开不等于设备在线。</p>}
        {Object.entries(status?.readings || {}).map(([target, reading]) => <p className="hw-note" key={target}>{target}：{!online || !known || reading.quality !== 'valid' || status?.state !== 'monitoring' ? '反馈已过期或不可用' : section === 'motors' ? `状态字 ${reading.raw} · ${reading.running ? '运行位为 1' : '运行位为 0（非安全停机确认）'} · ${reading.fault ? '故障' : '无故障位'} · ${reading.enabled ? '已使能' : '未使能'}` : reading.kind === 'position' ? `高度 ${reading.positionMm} mm（单位待实机核验）` : `错误码 ${reading.code}（00 不代表无故障）`}</p>)}
        {Object.entries(status?.commands || {}).map(([target, command]) => <p key={target} role="status" className="hw-note">{target}：{results[command.state]}{command.error && `：${command.error}`}</p>)}
        <div className="hw-sensor-actions">
          <button disabled={disabled || pending || !known || !online || !unlocked || connected} onClick={() => void operate(section, 'connect')}>连接{labels[section]}诊断</button>
          <button disabled={!online || !unlocked || !connected} onClick={() => void operate(section, 'stop')}>发送{labels[section]}停止</button>
          {section === 'motors' && <button disabled={!online || !unlocked || !connected} onClick={() => void operate(section, 'stop', true)}>发送电机软件急停</button>}
          <button disabled={!online || !unlocked || !connected} onClick={() => void operate(section, 'disconnect')}>停止并断开{labels[section]}</button>
        </div>
      </article>
    })}</div>
  </section>
}
