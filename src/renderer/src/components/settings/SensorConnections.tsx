import { useEffect, useRef, useState } from 'react'
import type { useController } from '../../hooks/useController'
import type { SensorStatuses, SensorSection, SensorRun, SensorEvent } from '../../../../shared/hardware'

const labels = { tension: '拉力', displacement: '位移' }
const states = { connecting: '连接中', collecting: '持续采集中', disconnecting: '断开中', disconnected: '已断开', failed: '采集故障' }
const qualities = { valid: '有效', stale: '已过期', invalid: '无效', unavailable: '不可用' }
const runStates = { running: '采集中', completed: '已结束', failed: '故障结束', interrupted: '异常中断' }
const kinds = { sample: '采样', quality: '质量变化', zero: '软件置零', end: '结束' }
const active = (state?: string) => ['connecting', 'collecting', 'disconnecting'].includes(state || '')

export function SensorConnections({ controller, unlocked, disabled, visible, onActive }: {
  controller: ReturnType<typeof useController>; unlocked: boolean; disabled: boolean; visible: boolean
  onActive: (active: boolean) => void
}) {
  const { request, online } = controller
  const [statuses, setStatuses] = useState<SensorStatuses>({})
  const [known, setKnown] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [pending, setPending] = useState(false)
  const [runs, setRuns] = useState<SensorRun[]>([])
  const [selected, setSelected] = useState('')
  const [events, setEvents] = useState<SensorEvent[]>([])
  const mounted = useRef(true)
  const revision = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKnown(false)
    if (!online || !unlocked) return
    async function poll() {
      const version = revision.current
      try {
        const value = await request<SensorStatuses>('hardware.sensors.status')
        if (!live || version !== revision.current) return
        setStatuses(value); setKnown(true); setStatusError('')
        onActive(Object.values(value).some(value => active(value?.state)))
      } catch (reason) {
        if (live && version === revision.current) { setKnown(false); setStatusError((reason as Error).message) }
      } finally {
        if (live) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [online, unlocked, request, onActive])

  async function operate(section: SensorSection, operation: 'connect' | 'disconnect' | 'zero') {
    if (pending || !online || !unlocked) return
    if (operation === 'connect' && !window.confirm('将打开该传感器串口、持续发送只读查询并独立保存真实数据。不会切换为真实运动试验；请确认现场安全和控制线影响。是否继续？')) return
    if (operation === 'zero' && !window.confirm('仅设置当前位移采集会话的软件相对零点，不写入设备；原始值和绝对值仍保留，重连后偏移清零。是否继续？')) return
    setPending(true); setError('')
    revision.current++
    try {
      const value = await request<SensorStatuses>(`hardware.sensors.${operation}`, { section })
      if (!mounted.current) return
      setStatuses(value); setKnown(true)
      onActive(Object.values(value).some(value => active(value?.state)))
    } catch (reason) { if (mounted.current) setError((reason as Error).message) }
    finally { revision.current++; if (mounted.current) setPending(false) }
  }

  async function history(sessionId = '', offset = 0) {
    if (pending || !online || !unlocked) return
    setPending(true); setError('')
    try {
      if (!sessionId) {
        const value = await request<SensorRun[]>('hardware.sensors.records.list')
        if (mounted.current) { setRuns(value); setSelected(''); setEvents([]) }
      } else {
        const value = await request<SensorEvent[]>('hardware.sensors.records.read', { sessionId, offset, limit: 50 })
        if (mounted.current) { setSelected(sessionId); setEvents(value) }
      }
    } catch (reason) { if (mounted.current) setError((reason as Error).message) }
    finally { if (mounted.current) setPending(false) }
  }

  return <section className="hw-sensor-panel" hidden={!visible} aria-label="真实传感器采集">
    <h3>真实传感器只读采集</h3>
    <p className="hw-note">连接后自动独立记录到 SQLite，不进入模拟试验或其 CSV。断线不自动重连；离开设置页或权限锁定不会自动结束采集，可使用停止/急停结束，或重新解锁后断开。</p>
    {(error || statusError) && <p role="alert" className="settings-warning">{error || statusError}</p>}
    <div className="hw-grid">{(['tension', 'displacement'] as const).map(section => {
      const status = statuses[section]
      const reading = online && known && status?.quality === 'valid' ? status.reading : null
      return <article className="hw-box" key={section} aria-label={`${labels[section]}持续采集`}>
        <h4>{labels[section]}<span>{!online || !known ? '状态未知' : status ? states[status.state] : '未连接'}</span></h4>
        <p className="hw-sensor-value">{reading?.value ?? '—'} <small>{reading?.unit || ''}</small></p>
        <p className="hw-note">数据质量：{known && online && status ? qualities[status.quality] : '不可用'} · 来源：真实硬件</p>
        {status && <p className="hw-note">会话 {status.sessionId.slice(0, 8)} · 配置版本 {status.configVersion.slice(0, 12)}</p>}
        {reading && <p className="hw-note">原始值 {reading.raw} · 绝对值 {reading.absoluteValue} · 软件偏移 {reading.zeroOffset}<br />主机接收：{new Date(reading.receivedAt * 1000).toLocaleString()}</p>}
        {status?.lastValid && !reading && <p className="hw-note">最后有效接收时间：{new Date(status.lastValid.receivedAt * 1000).toLocaleString()}（历史，非当前值）</p>}
        {status?.error && <p role="status" className="settings-warning">{status.error}</p>}
        <div className="hw-sensor-actions">
          <button disabled={disabled || !known || pending || !online || !unlocked || active(status?.state)} onClick={() => void operate(section, 'connect')}>连接{labels[section]}并采集</button>
          <button disabled={!online || !unlocked || pending || !active(status?.state)} onClick={() => void operate(section, 'disconnect')}>断开{labels[section]}</button>
          {section === 'displacement' && <button disabled={!online || !unlocked || pending || !reading} onClick={() => void operate(section, 'zero')}>位移相对置零</button>}
        </div>
      </article>
    })}</div>
    <div className="hw-sensor-actions"><button disabled={!online || !unlocked || pending} onClick={() => void history()}>刷新真实采集记录</button><span className="hw-note">最近 20 次会话，事件包含采样、过期、置零及结束信息。</span></div>
    {runs.length > 0 && <label>采集记录<select aria-label="真实采集记录" value={selected} disabled={pending} onChange={event => { if (event.target.value) void history(event.target.value) }}><option value="">请选择记录</option>{runs.map(run => <option key={run.id} value={run.id}>{labels[run.section]} · {new Date(run.startedAt * 1000).toLocaleString()} · {runStates[run.status]} · {run.eventCount} 条事件</option>)}</select></label>}
    {selected && <><div className="hw-note">会话 {selected} · 来源 hardware · 配置版本 {runs.find(run => run.id === selected)?.configVersion}</div><div className="hw-sensor-table"><table><thead><tr><th>序号 / 类型</th><th>主机接收时间</th><th>质量</th><th>值 / 原始值</th><th>绝对值 / 软件偏移</th></tr></thead><tbody>{events.map(event => <tr key={event.number}><td>{event.number} / {kinds[event.kind]}</td><td>{new Date(event.receivedAt * 1000).toLocaleString()}</td><td>{qualities[event.quality]}{event.error && `：${event.error}`}</td><td>{event.value ?? '—'} {event.unit} / {event.raw ?? '—'}</td><td>{event.absoluteValue ?? '—'} / {event.zeroOffset ?? '—'}</td></tr>)}</tbody></table></div><div className="hw-sensor-actions"><button disabled={pending} onClick={() => void history(selected)}>回到首条</button><button disabled={pending || events.length < 50} onClick={() => void history(selected, events.at(-1)!.number)}>下一页</button></div></>}
  </section>
}
