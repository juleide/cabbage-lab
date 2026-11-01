export interface SerialSettings {
  port: string
  baud: number | null
  bits: 5 | 6 | 7 | 8
  parity: 'N' | 'E' | 'O'
  stop: 1 | 2
  timeoutMs: number
  intervalMs: number
}
export interface MotorOperation {
  direction: -1 | 1 | null
  speedRpm: number | null
  maxSpeedRpm: number | null
  accelerationMs: number | null
  decelerationMs: number | null
  maxRunMs: number | null
}
export interface HardwareConfig {
  schemaVersion: 2
  motors: { serial: SerialSettings; motor1: number | null; motor2: number | null; operation: Record<'motor1' | 'motor2', MotorOperation> }
  lift: { serial: SerialSettings; interface: 'RS232' | 'RS485' }
  array: { mode: 'usb' | 'serial'; press: { rev: number; serial: SerialSettings }; grip: { rev: number; serial: SerialSettings } }
  tension: { serial: SerialSettings; station: number | null; unit: string; decimals: number }
  displacement: { serial: SerialSettings; station: number | null; model: '' | 'p' | 'g'; channel: number; reading: 'raw' | 'float'; rawMin: number | null; rawMax: number | null; lower: number | null; upper: number | null; unit: string }
}
export interface HardwareSnapshot { config: HardwareConfig; error: string | null; warnings?: string[]; drivers: { available: false; message: string } }
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

export type MotionSection = 'motors' | 'lift'
export interface MotionStatus {
  sessionId: string
  section: MotionSection
  source: 'hardware'
  state: 'connecting' | 'monitoring' | 'disconnecting' | 'disconnected' | 'failed'
  faultLatched: boolean
  motionAllowed: false
  auditDropped: number
  diagnosticGuard?: {
    state: 'waiting' | 'observing' | 'tripped' | 'closed'
    reason: string | null
    trippedAt: number | null
    intervalMs: number
    physicalStopConfirmed: false
  }
  configVersion: string
  error: string | null
  readings: Record<string, {
    quality: 'valid' | 'stale'
    receivedAt: number
    ageMs: number
    raw?: number
    position?: {
      highWord: number
      lowWord: number
      rawUnsigned: number
      interpretationVerified: false
      receivedAt: number
      ageMs: number
      quality: 'valid' | 'stale'
    }
    running?: boolean
    fault?: boolean
    enabled?: boolean
    positiveLimit?: boolean
    negativeLimit?: boolean
    positionMm?: number
    code?: number
    kind?: 'position' | 'error'
  }>
  commands: Record<string, {
    id: string
    emergency: boolean
    state: 'queued' | 'acknowledged' | 'sent' | 'unknown'
    motionConfirmed: false
    error: string | null
  }>
}
export type MotionStatuses = Partial<Record<MotionSection, MotionStatus>>

export type MotorTarget = 'motor1' | 'motor2'
export interface MotorAxisStatus {
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'unknown'
  commandId: string | null
  error: string | null
  driverStopped: boolean
  physicalStopConfirmed: false
  canStart: boolean
  startBlocked: string | null
}
export interface MotorControlStatus extends Omit<MotionStatus, 'motionAllowed' | 'section' | 'readings'> {
  section: 'motors'
  purpose: 'control'
  confirmationMs: number
  axes: Record<MotorTarget, MotorAxisStatus>
  readings: Partial<Record<MotorTarget, MotionStatus['readings'][string] & {
    speed?: { rpm: number; raw: number; receivedAt: number; ageMs: number; quality: 'valid' | 'stale' }
  }>>
}
