import { useEffect, useRef, useState } from 'react'
import type { useController } from '../../hooks/useController'
import type { HardwareSection, MotionStatuses, SensorStatuses } from '../../../../shared/hardware'

const names = { motors: '电机总线', lift: '升降装置', tension: '拉力传感器', displacement: '位移传感器', array: '电子皮肤' }
const phases = { connecting: '连接中', monitoring: '已连接', collecting: '已连接', disconnecting: '断开中', disconnected: '未连接', failed: '连接异常' }
const active = (state?: string) => ['connecting', 'monitoring', 'collecting', 'disconnecting'].includes(state || '')

export function ConnectionStatus({ controller, unlocked, scope, disabled, onActive }: {
  controller: ReturnType<typeof useController>
  unlocked: boolean
  scope?: HardwareSection
  disabled: boolean
  onActive: (active: boolean) => void
}) {
  const { request, online } = controller
  const [motion, setMotion] = useState<MotionStatuses>({})
  const [sensors, setSensors] = useState<SensorStatuses>({})
  const [known, setKnown] = useState(false)
  const [pending, setPending] = useState<HardwareSection | null>(null)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const allowed = useRef(false)
  const mounted = useRef(true)
  const operating = useRef(false)
  allowed.current = online && unlocked
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setKnown(false)
    if (!online || !unlocked) { onActive(false); return }
    async function poll() {
      try {
        const [motionValue, sensorValue] = await Promise.all([
          request<MotionStatuses>('hardware.motion.status'), request<SensorStatuses>('hardware.sensors.status')
        ])
        if (!live) return
        setMotion(motionValue); setSensors(sensorValue); setKnown(true); setPollError('')
        onActive([...Object.values(motionValue), ...Object.values(sensorValue)].some(value => active(value?.state)))
      } catch (reason) {
        if (live) { setKnown(false); setPollError((reason as Error).message) }
      } finally {
        if (live) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [online, unlocked, request, onActive])

  async function reconnect(section: Exclude<HardwareSection, 'array'>) {
    if (disabled || !allowed.current || operating.current) return
    const sensor = section === 'tension' || section === 'displacement'
    if (!sensor && !window.confirm('重新连接会请求停止并关闭该执行机构串口，再只读连接；不会恢复运动。请确认现场安全。')) return
    operating.current = true
    setPending(section); setError('')
    try {
      await request(sensor ? 'hardware.sensors.disconnect' : 'hardware.motion.disconnect', { section })
    } catch (reason) {
      // An absent session needs no disconnect; other errors must not be ignored.
      if (!String((reason as Error).message).includes('没有活动')) {
        if (mounted.current) setError((reason as Error).message)
        operating.current = false
        if (mounted.current) setPending(null)
        return
      }
    }
    try {
      const deadline = performance.now() + 3000
      while (true) {
        if (!mounted.current || !allowed.current) return
        const statuses = await request<MotionStatuses & SensorStatuses>(sensor ? 'hardware.sensors.status' : 'hardware.motion.status')
        const status = statuses[section]
        if (!active(status?.state)) break
        if (performance.now() >= deadline) throw new Error('旧连接尚未释放，请稍后重新连接')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!mounted.current || !allowed.current) return
      await request(sensor ? 'hardware.sensors.connect' : section === 'motors' ? 'hardware.motor.connect' : 'hardware.motion.connect', section === 'motors' ? {} : { section })
      if (mounted.current) controller.notify('已请求连接，等待真实设备反馈；不会自动启动')
    } catch (reason) {
      if (mounted.current) setError((reason as Error).message)
    } finally {
      operating.current = false
      if (mounted.current) setPending(null)
    }
  }

  const sections: HardwareSection[] = scope ? [scope] : ['motors', 'lift', 'tension', 'displacement', 'array']
  return <section className="hw-connection-status" aria-label="设备连接状态">
    <h3>连接状态</h3>
    {(error || pollError) && <p role="alert" className="settings-warning">{error || pollError}</p>}
    {sections.map(section => {
      const sensor = section === 'tension' || section === 'displacement'
      const status = section === 'array' ? undefined : sensor ? sensors[section] : motion[section]
      const fresh = online && known && sensor && sensors[section]?.state === 'collecting' && sensors[section]?.quality === 'valid'
      const reading = sensor ? sensors[section]?.reading : null
      const visible = online && unlocked && known
      return <div className="hw-connection-row" key={section}>
        <div><strong>{names[section]}</strong><span>{!visible ? '状态未知' : section === 'array' ? '驱动未接入' : status ? phases[status.state] : '未连接'}</span>
          {sensor && <span>当前读数：{fresh ? reading?.value ?? 0 : 0} {fresh ? reading?.unit : ''}</span>}
          {visible && status?.error && <p className="settings-warning">{status.error}</p>}
        </div>
        {section !== 'array' && <button disabled={!visible || disabled || pending !== null} onClick={() => void reconnect(section)}>{pending === section ? '连接中…' : '重新连接'}</button>}
      </div>
    })}
  </section>
}
