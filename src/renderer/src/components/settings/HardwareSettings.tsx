import { useEffect, useRef, useState } from 'react'
import type { useController } from '../../hooks/useController'
import type { HardwareConfig, HardwareSnapshot, HardwareCheck, HardwareSection, SerialSettings, SerialPortInfo, SerialPortScan, HardwareVerification } from '../../../../shared/hardware'
import '../../styles/hardware.css'

type Tab = 'overview' | 'actuators' | 'array' | 'sensors'
const labels: Record<HardwareSection, string> = { motors: '电机', lift: '升降', array: '电子皮肤', tension: '拉力', displacement: '位移' }
const sectionNames: Record<string, string> = { ...labels, serial: '通信', motor1: '1 号电机站号', motor2: '2 号电机站号', press: '按压', grip: '抓取', port: '串口', baud: '波特率', bits: '数据位', parity: '校验位', stop: '停止位', timeoutMs: '响应超时', intervalMs: '读取间隔', station: '站号', unit: '单位', decimals: '小数位', channel: '通道', model: '模块类型', reading: '读取方式', rawMin: '原始值下限', rawMax: '原始值上限', lower: '位移下限', upper: '位移上限', rev: 'REV' }
function readable(message: string) { return message.replace(/[a-zA-Z]+(?:\.[a-zA-Z0-9]+)*/g, word => word.split('.').map(part => sectionNames[part] || part).join(' / ')) }

export function HardwareSettings({ controller, onDirtyChange, unlocked }: { unlocked: boolean; controller: ReturnType<typeof useController>; onDirtyChange: (dirty: boolean) => void }) {
  const { request, online, state, busy, notify } = controller
  const [config, setConfig] = useState<HardwareConfig | null>(null)
  const [saved, setSaved] = useState('')
  const [loadError, setLoadError] = useState('')
  const [storeError, setStoreError] = useState('')
  const [capability, setCapability] = useState('')
  const [working, setWorking] = useState(false)
  const [verification, setVerification] = useState<HardwareVerification | null>(null)
  const [verificationError, setVerificationError] = useState('')
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const scanGeneration = useRef(0)
  const [tab, setTab] = useState<Tab>('overview')
  const [actuator, setActuator] = useState<'motors' | 'lift'>('motors')
  const [sensor, setSensor] = useState<'tension' | 'displacement'>('tension')
  const [result, setResult] = useState<string[] | null>(null)
  const [checked, setChecked] = useState('')
  const revision = useRef(0)
  const generation = useRef(0)
  const form = useRef<HTMLFormElement>(null)
  const serialized = JSON.stringify(config)
  const dirty = config !== null && saved !== serialized
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const idle = !!state && !state.running && !Object.values(state.devices).some(Boolean)
  const scope = tab === 'actuators' ? actuator : tab === 'sensors' ? sensor : tab === 'array' ? 'array' : undefined
  const verifying = verification?.state === 'checking'
  const supportsVerification = scope === 'motors' || scope === 'tension' || scope === 'displacement'

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!online || !unlocked) { setVerification(null); return }
    async function poll() {
      try {
        const value = await request<HardwareVerification>('hardware.status')
        if (!live) return
        setVerification(value); setVerificationError('')
        if (value.state === 'checking') timer = setTimeout(() => void poll(), 300)
      } catch (reason) {
        if (live) setVerificationError((reason as Error).message)
      }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [online, unlocked, verifying, request])

  async function verify(cancel = false) {
    if (working || !online) return
    if (!cancel && (!scope || !supportsVerification || dirty || !idle || storeError)) return
    if (!cancel && !window.confirm('将打开所选设备串口并发送只读查询，不发送运动指令。部分适配器打开时仍可能影响控制线；请确认现场安全。是否继续？')) return
    setWorking(true); setVerificationError('')
    try {
      const value = await request<HardwareVerification>(cancel ? 'hardware.verify.cancel' : 'hardware.verify', cancel ? {} : { section: scope })
      setVerification(value)
    } catch (reason) { setVerificationError((reason as Error).message) }
    finally { setWorking(false) }
  }

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  async function load() {
    const id = ++generation.current
    setWorking(true); setLoadError('')
    try {
      const value = await request<HardwareSnapshot>('hardware.get')
      if (id !== generation.current) return
      setConfig(value.config); setSaved(JSON.stringify(value.config)); setStoreError(value.error || '')
      setCapability(value.drivers.message); setResult(null); setChecked(''); revision.current++
    } catch (reason) { if (id === generation.current) setLoadError((reason as Error).message) }
    finally { if (id === generation.current) setWorking(false) }
  }
  useEffect(() => {
    setScanning(false); setPorts(null); setScanError('')
    if (unlocked && online && (!config || !dirtyRef.current)) void load()
    return () => { generation.current++; scanGeneration.current++ }
    // Keep unsaved drafts across controller disconnects; do not reload over user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, unlocked])
  async function scan() {
    if (scanning || !online || !unlocked) return
    const id = ++scanGeneration.current
    setScanning(true); setScanError(''); setPorts(null)
    try {
      const value = await request<SerialPortScan>('hardware.ports.list')
      if (id === scanGeneration.current) setPorts(value.ports)
    } catch (reason) {
      if (id === scanGeneration.current) setScanError((reason as Error).message)
    } finally {
      if (id === scanGeneration.current) setScanning(false)
    }
  }
  function edit(next: HardwareConfig) { revision.current++; setConfig(next); setResult(null); setChecked('') }
  function patch<K extends HardwareSection>(key: K, value: Partial<HardwareConfig[K]>) {
    if (config) edit({ ...config, [key]: { ...config[key], ...value } })
  }
  async function save() {
    if (!config || working || busy || !idle || storeError) return
    setWorking(true)
    try {
      const value = await request<HardwareConfig>('hardware.save', { config })
      setConfig(value); setSaved(JSON.stringify(value)); notify('设备连接草稿已保存；未连接真实硬件')
      setVerification(null)
    } catch (reason) { setResult([(reason as Error).message]) }
    finally { setWorking(false) }
  }
  async function check() {
    if (!config || working) return
    const rev = revision.current
    setWorking(true)
    try {
      const value = await request<HardwareCheck>('hardware.check', { config, ...(scope ? { section: scope } : {}) })
      if (rev !== revision.current) return
      setResult(value.errors); setChecked(value.errors.length ? '' : serialized + ':' + (scope || 'all'))
    } catch (reason) { setResult([(reason as Error).message]) }
    finally { setWorking(false) }
  }
  function number(value: number | null, change: (value: number | null) => void, min?: number, max?: number, step: number | 'any' = 1, fixed = false) {
    return <input type="number" value={value ?? ''} min={min} max={max} step={step} readOnly={fixed} placeholder="请填写" onChange={e => change(e.target.value === '' ? null : Number(e.target.value))} />
  }
  function serial(value: SerialSettings, change: (value: SerialSettings) => void, title: string, shared = false) {
    return <article className="hw-box"><h4>{title}<span>{verifying && verification.section === scope ? '只读验证中' : '未持续连接'}</span></h4><div className="hw-grid">
      <label>{shared ? '共用串口' : '串口'}<div className="hw-port"><input aria-label={shared ? '共用串口' : '串口'} value={value.port} placeholder="COM3 或 /dev/ttyUSB0" onChange={e => change({ ...value, port: e.target.value })} /><button type="button" disabled={!online || scanning} onClick={() => void scan()}>{scanning ? '扫描中…' : '扫描'}</button></div></label>
      <label>波特率<input type="number" list="hw-baud-rates" value={value.baud ?? ''} min="1" max="4000000" step="1" placeholder="选择或输入" onChange={e => change({ ...value, baud: e.target.value === '' ? null : Number(e.target.value) })} /></label>
    </div>{ports && <><label>扫描结果<select aria-label={title + '扫描结果'} value="" onChange={e => { if (e.target.value) change({ ...value, port: e.target.value }) }}><option value="">{ports.length ? '选择端口（也可手动填写）' : '未发现串口，可刷新或手动填写'}</option>{ports.map(port => <option key={port.port} value={port.port}>{port.port} · {port.description}{port.serialNumber ? ` · ${port.serialNumber}` : ''}</option>)}</select></label>{value.port.trim() && !ports.some(port => port.port === value.port.trim() || (/^com\d+$/i.test(port.port) && port.port.toUpperCase() === value.port.trim().toUpperCase())) && <p className="hw-note">所填端口不在本次扫描结果中；配置已保留，请检查连接或手动确认。</p>}</>}<details><summary>高级通信参数</summary><div className="hw-grid">
      <label>数据位<select value={value.bits} onChange={e => change({ ...value, bits: Number(e.target.value) as SerialSettings['bits'] })}>{[8, 7, 6, 5].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>校验位<select value={value.parity} onChange={e => change({ ...value, parity: e.target.value as SerialSettings['parity'] })}><option value="N">无校验 N</option><option value="E">偶校验 E</option><option value="O">奇校验 O</option></select></label>
      <label>停止位<select value={value.stop} onChange={e => change({ ...value, stop: Number(e.target.value) as 1 | 2 })}><option>1</option><option>2</option></select></label>
      <label>响应超时（ms）<input type="number" required value={Number.isFinite(value.timeoutMs) ? value.timeoutMs : ''} min="50" max="60000" onChange={e => change({ ...value, timeoutMs: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>
      <label>读取间隔（ms）<input type="number" required value={Number.isFinite(value.intervalMs) ? value.intervalMs : ''} min="10" max="60000" onChange={e => change({ ...value, intervalMs: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>
    </div></details></article>
  }
  if (!config) return <section className="settings-card"><h3>设备连接</h3><p role="status">{loadError || (online ? '正在加载设备配置…' : '控制端离线，无法加载设备配置')}</p><button disabled={!online || working} onClick={() => void load()}>重新加载</button></section>
  const d = config.displacement
  return <section className="settings-card hardware-settings">
    <header className="hw-heading"><div><h2>设备连接</h2><p>配置端口、设备绑定与数据解析参数</p></div><span className="hw-mode">模拟试验 · 支持只读验证</span></header>
    <nav className="hw-tabs" aria-label="设备配置分类">{([['overview', '连接概览'], ['actuators', '执行机构'], ['array', '电子皮肤'], ['sensors', '拉力与位移']] as const).map(([key, label]) => <button key={key} disabled={working} aria-pressed={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setResult(null) }}>{label}</button>)}<span>{dirty ? '未保存' : '草稿已保存'}</span></nav>
    {storeError && <p className="settings-warning" role="alert">{storeError}。为保护原文件，暂不可保存。请通过“数据与日志”打开配置目录处理后重启控制端。</p>}
    {!online && <p className="settings-warning" role="alert">控制端离线；草稿保留，恢复连接后可继续保存。</p>}
    {scanError && <p className="settings-warning" role="alert">{scanError}；可继续手动填写端口。</p>}
    {ports !== null && <p className="hw-note" role="status">扫描完成：发现 {ports.length} 个串口。仅枚举端口，未打开或验证设备；选择后需保存草稿。</p>}
    <form ref={form} onSubmit={e => e.preventDefault()} className="hw-body"><fieldset disabled={working || verifying}>
      <datalist id="hw-baud-rates">{[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(n => <option key={n} value={n} />)}</datalist>
      {tab === 'overview' && <><div className="hw-overview">{([['actuators', '执行机构', '2 个电机 · 1 个升降', `电机 ${config.motors.serial.port || '未配置'} · 升降 ${config.lift.serial.port || '未配置'}`], ['array', '电子皮肤', '按压 / 抓取 · 64 × 64', config.array.mode === 'usb' ? `按压 REV ${config.array.press.rev} · 抓取 REV ${config.array.grip.rev}` : `按压 ${config.array.press.serial.port || '未配置'} · 抓取 ${config.array.grip.serial.port || '未配置'}`], ['sensors', '拉力与位移', '各 1 个采集模块', `拉力 ${config.tension.serial.port || '未配置'} · 位移 ${d.serial.port || '未配置'}`]] as const).map(([key, title, subtitle, detail]) => <article className="hw-box" key={key}><h3>{title}</h3><p>{subtitle}</p><p>{detail}</p><button type="button" onClick={() => setTab(key)}>设置连接 →</button></article>)}</div><p className="hw-note">保存的是设备连接草稿，不会改变当前模拟试验，也不会自动打开设备或发送控制指令。</p></>}
      {tab === 'actuators' && <><div className="hw-switch"><button type="button" aria-pressed={actuator === 'motors'} onClick={() => { setActuator('motors'); setResult(null) }}>步进电机 · 共用总线</button><button type="button" aria-pressed={actuator === 'lift'} onClick={() => { setActuator('lift'); setResult(null) }}>升降装置 · 独立连接</button></div>{actuator === 'motors' ? <>
        {serial(config.motors.serial, value => patch('motors', { serial: value }), 'RS485 · Modbus RTU', true)}
        <div className="hw-grid">{(['motor1', 'motor2'] as const).map((id, i) => <label key={id}>{i + 1} 号电机站号{number(config.motors[id], value => patch('motors', { [id]: value }), 1, 254)}</label>)}</div><p className="hw-note">两个电机共用总线，站号不能重复；通信参数需与驱动器一致。</p>
      </> : <><label>连接接口<select value={config.lift.interface} onChange={e => patch('lift', { interface: e.target.value as 'RS232' | 'RS485' })}><option>RS232</option><option>RS485</option></select></label>{serial(config.lift.serial, value => patch('lift', { serial: value }), '霍尔升降控制器')}<p className="hw-note">RS232 预设 38400 / 8N1，可按实物调整；自定义帧，无站号，不自动复位或清错。</p></>}</>}
      {tab === 'array' && <><label>连接方式<select value={config.array.mode} onChange={e => patch('array', { mode: e.target.value as 'usb' | 'serial' })}><option value="usb">USB</option><option value="serial">串口</option></select></label>{(['press', 'grip'] as const).map((key, i) => config.array.mode === 'usb' ? <article className="hw-box" key={key}><h4>{i ? '抓取' : '按压'}采集器<span>未连接</span></h4><label>REV 号<select value={config.array[key].rev} onChange={e => patch('array', { [key]: { ...config.array[key], rev: Number(e.target.value) } })}>{[0, 1, 2, 3].map(n => <option key={n}>{n}</option>)}</select></label></article> : <div key={key}>{serial(config.array[key].serial, value => patch('array', { [key]: { ...config.array[key], serial: value } }), (i ? '抓取' : '按压') + '采集器')}</div>)}<p className="hw-note">USB 按 REV 号区分；串口按独立端口区分，两台不能重复绑定。未标定点阵只显示原始值。</p></>}
      {tab === 'sensors' && <><div className="hw-switch"><button type="button" aria-pressed={sensor === 'tension'} onClick={() => { setSensor('tension'); setResult(null) }}>拉力采集</button><button type="button" aria-pressed={sensor === 'displacement'} onClick={() => { setSensor('displacement'); setResult(null) }}>位移采集</button></div>{sensor === 'tension' ? <>
        {serial(config.tension.serial, value => patch('tension', { serial: value }), 'GJ9658B · Modbus RTU')}
        <div className="hw-grid"><label>实际站号{number(config.tension.station, value => patch('tension', { station: value }), 1, 247)}</label><label>显示单位<input required value={config.tension.unit} list="hw-units" onChange={e => patch('tension', { unit: e.target.value })} /></label><label>小数位<input type="number" required min="0" max="9" value={Number.isFinite(config.tension.decimals) ? config.tension.decimals : ''} onChange={e => patch('tension', { decimals: e.target.value === '' ? NaN : Number(e.target.value) })} /></label></div><datalist id="hw-units">{['原始值', 'N', 'kg', 'g', 'kN'].map(unit => <option key={unit}>{unit}</option>)}</datalist><p className="hw-note">站号 = 拨码值 + 偏移；int32 低字在前。单位与小数位按标定填写；写指令后至少等待 500 ms。</p>
      </> : <>
        {serial(d.serial, value => patch('displacement', { serial: value }), '直线位移 · Modbus RTU')}
        <div className="hw-grid"><label>模块类型<select value={d.model} onChange={e => { const model = e.target.value as typeof d.model; patch('displacement', { model, ...(model === 'p' ? { channel: 1, rawMin: 0, rawMax: 5000 } : {}) }) }}><option value="">请选择模块类型</option><option value="p">P · MM-V05-485-R 专用模块</option><option value="g">G · 通用采集器</option></select></label><label>站号{number(d.station, value => patch('displacement', { station: value }), 1, 247)}</label></div>
        <details open><summary>通道与位移换算</summary><div className="hw-grid"><label>通道<select aria-label="通道" disabled={d.model === 'p'} value={d.channel} onChange={e => patch('displacement', { channel: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>CH{n}</option>)}</select></label><label>读取方式<select value={d.reading} onChange={e => patch('displacement', { reading: e.target.value as 'raw' | 'float' })}><option value="raw">原始值换算</option><option value="float">模块 float32 结果</option></select></label>
          {d.reading === 'raw' && (['rawMin', 'rawMax', 'lower', 'upper'] as const).map((key, i) => <label key={key}>{['原始值下限', '原始值上限', '位移下限', '位移上限'][i]}{number(d[key], value => patch('displacement', { [key]: value }), -1e12, 1e12, 'any', d.model === 'p' && i < 2)}</label>)}<label>结果单位<input required value={d.unit} onChange={e => patch('displacement', { unit: e.target.value })} /></label></div><p className="hw-note">{d.reading === 'raw' ? '按原始值范围与实际量程线性换算；超范围数据标记异常。' : '按 ABCD 大端 float32 解析，不重复缩放；单位需与模块内部配置一致。'}</p></details><p className="hw-note">P / G 寄存器表不同，请按实物选择；这些是应用读取参数，不会写入设备。</p>
      </>}</>}
    </fieldset></form>
    {result !== null && <div className={`hw-result${result.length ? ' error' : ''}`} role="status">{result.length ? <ul>{result.map((error, i) => <li key={i}>{readable(error)}</li>)}</ul> : '配置检查通过，不代表硬件连接成功。'}</div>}
    {verificationError && <p className="settings-warning" role="alert">{verificationError}</p>}
    {verification && verification.state !== 'idle' && <div className="hw-result" role="status"><strong>{verification.section ? labels[verification.section] : ''}只读验证</strong><p>{verification.message}</p>{verification.readings && <p style={{ overflowWrap: 'anywhere' }}>本次读取：{JSON.stringify(verification.readings)}</p>}{dirty && <p>草稿已修改，以上结果不适用于未保存配置。</p>}<p>仅为一次性诊断，非持续连接或实时采样；当前试验仍使用模拟设备。</p></div>}
    <footer className="hw-footer"><p>{capability} 现支持电机、拉力和位移的一次性只读验证；升降及电子皮肤暂不支持。请进入对应分类操作。</p><div><button disabled={!online || working || verifying} onClick={() => { if (form.current?.reportValidity()) void check() }}>检查{scope ? labels[scope] : '全部'}配置</button><button disabled={!online || working || verifying || !idle || busy || !!storeError || !supportsVerification || dirty || checked !== serialized + ':' + (scope || 'all')} onClick={() => void verify()}>连接验证</button>{verifying && <button disabled={!online || working} onClick={() => void verify(true)}>取消验证</button>}<button className="hw-primary" disabled={!online || working || verifying || !idle || busy || !!storeError || !dirty} onClick={() => { if (form.current?.reportValidity()) void save() }}>{working ? '处理中…' : '保存草稿'}</button></div>{!idle && <small>请先停止试验并关闭执行机构后保存配置或验证通信。</small>}</footer>
  </section>
}
