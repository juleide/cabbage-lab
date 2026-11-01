export interface SerialSettings {
  port: string
  baud: number | null
  bits: 5 | 6 | 7 | 8
  parity: 'N' | 'E' | 'O'
  stop: 1 | 2
  timeoutMs: number
  intervalMs: number
}
export interface HardwareConfig {
  schemaVersion: 1
  motors: { serial: SerialSettings; motor1: number | null; motor2: number | null }
  lift: { serial: SerialSettings; interface: 'RS232' | 'RS485' }
  array: { mode: 'usb' | 'serial'; press: { rev: number; serial: SerialSettings }; grip: { rev: number; serial: SerialSettings } }
  tension: { serial: SerialSettings; station: number | null; unit: string; decimals: number }
  displacement: { serial: SerialSettings; station: number | null; model: '' | 'p' | 'g'; channel: number; reading: 'raw' | 'float'; rawMin: number | null; rawMax: number | null; lower: number | null; upper: number | null; unit: string }
}
export interface HardwareSnapshot { config: HardwareConfig; error: string | null; drivers: { available: false; message: string } }
export interface HardwareCheck { errors: string[] }
export interface SerialPortInfo {
  port: string
  description: string
  manufacturer: string | null
  vid: number | null
  pid: number | null
  serialNumber: string | null
  location: string | null
}
export interface SerialPortScan { ports: SerialPortInfo[] }
export interface HardwareVerification {
  state: 'idle' | 'checking' | 'passed' | 'failed' | 'cancelled'
  sessionId: string | null
  section: HardwareSection | null
  message: string
  port?: string
  startedAt?: number
  finishedAt?: number
  readings: Record<string, unknown> | null
  phase?: 'opening' | 'reading' | 'closed'
}
export type SensorSection = 'tension' | 'displacement'
export interface SensorEvent {
  number: number
  sessionId: string
  section: SensorSection
  source: 'hardware'
  kind: 'sample' | 'quality' | 'zero' | 'end'
  quality: 'valid' | 'stale' | 'invalid' | 'unavailable'
  receivedAt: number
  raw: number | null
  value: number | null
  absoluteValue?: number
  zeroOffset?: number
  unit?: string
  error?: string | null
}
export interface SensorStatus {
  sessionId: string
  section: SensorSection
  source: 'hardware'
  state: 'connecting' | 'collecting' | 'disconnecting' | 'disconnected' | 'failed'
  quality: SensorEvent['quality']
  reading: SensorEvent | null
  lastValid: SensorEvent | null
  error: string | null
  configVersion: string
  zeroOffset: number
  startedAt: number
  finishedAt: number | null
  staleAfterMs: number
  ageMs?: number
}
export type SensorStatuses = Partial<Record<SensorSection, SensorStatus>>
export interface SensorRun {
  id: string
  section: SensorSection
  source: 'hardware'
  startedAt: number
  endedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  configVersion: string
  config: HardwareConfig[SensorSection]
  error: string | null
  eventCount: number
}
export type HardwareSection = 'motors' | 'lift' | 'array' | 'tension' | 'displacement'

function finite(value: number) {
  if (!Number.isFinite(value)) throw new Error('设备数据不是有效数值')
  return value
}
export function displacementAddress(config: HardwareConfig['displacement']) {
  if (!['p', 'g'].includes(config.model) || !Number.isInteger(config.channel) || config.channel < 1 || config.channel > 3 || (config.model === 'p' && config.channel !== 1)) throw new Error('模块类型或通道无效')
  return config.model === 'p' ? (config.reading === 'raw' ? 0 : 2) : (config.reading === 'raw' ? config.channel - 1 : 6 + (config.channel - 1) * 2)
}
export function convertDisplacement(raw: number, config: HardwareConfig['displacement']) {
  finite(raw)
  if (config.reading === 'float') return raw
  const { rawMin, rawMax, lower, upper } = config
  if ([rawMin, rawMax, lower, upper].some(x => x === null || !Number.isFinite(x)) || rawMax! <= rawMin! || upper! <= lower!) throw new Error('位移换算范围无效')
  if (raw < rawMin! || raw > rawMax!) throw new Error('位移原始值超出配置范围')
  return lower! + (raw - rawMin!) / (rawMax! - rawMin!) * (upper! - lower!)
}
export function decodeTension(low: number, high: number, decimals: number) {
  if (![low, high].every(x => Number.isInteger(x) && x >= 0 && x <= 65535) || !Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('拉力数据或小数位无效')
  return ((high << 16) | low) / 10 ** decimals
}
export function decodeDisplacementFloat(high: number, low: number) {
  if (![high, low].every(x => Number.isInteger(x) && x >= 0 && x <= 65535)) throw new Error('位移寄存器无效')
  const view = new DataView(new ArrayBuffer(4))
  view.setUint16(0, high); view.setUint16(2, low)
  return finite(view.getFloat32(0))
}
