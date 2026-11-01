export type DeviceId = 'motor1' | 'motor2' | 'lift'
export type MapMode = 'press' | 'grip'
export type Theme = 'light' | 'dark' | 'blue'
export type RecordLibrary = 'cabbage_test_2026' | 'cabbage_test_archive'

export interface Measurements {
  normal: number
  area: number
  friction: number
  speed: number
  coefficient: number
  pressure: number
}
export interface Sample extends Measurements { time: string }
export interface LogEntry { time: string; message: string }
export interface LabConfig {
  schemaVersion: 1
  defaultPressure: number
  sampleIntervalMs: number
  recordPrefix: string
  defaultLibrary: RecordLibrary
}
export interface DisplayRange { minimum: number; maximum: number }
export interface CorrectionStatus {
  active: boolean
  collecting: boolean
  collected: number
  target: number
  appliedAt: string | null
  error: string | null
}
export interface ArrayStatistics {
  minimum: number
  maximum: number
  mean: number
  maxRow: number
  maxColumn: number
}
export interface ArrayDiagnostics {
  validFrames: number
  crcErrors: number
  droppedFrames: number
  duplicateRows: number
  captureFps: number
  lastFrameAt: string | null
}
export interface PressureStatus {
  processingVersion: number
  correction: CorrectionStatus
  diagnostics: ArrayDiagnostics
  mode: MapMode
  generation: number
  paused: boolean
  error: string | null
}
export interface PressureFrame {
  sequence: number
  deviceFrame: number
  capturedAt: string
  width: 64
  height: 64
  values: number[]
  displayValues: number[]
  processingVersion: number
  correction: CorrectionStatus
  rawStatistics: ArrayStatistics
  displayStatistics: ArrayStatistics
  mode: MapMode
  generation: number
  source: 'simulation'
  stats: ArrayDiagnostics
}
export interface LabState {
  array: PressureStatus
  devices: Record<DeviceId, boolean>
  initialized: boolean
  running: boolean
  stopped: boolean
  zero: boolean
  pressure: number
  tick: number
  values: Measurements
  database: RecordLibrary
  runId: string | null
  sampleCount: number
}
export interface Snapshot {
  pressureFrame: PressureFrame | null
  state: LabState
  config: LabConfig
  configError: string | null
  logs: LogEntry[]
}
export interface RunRecord {
  id: string
  startedAt: string
  endedAt: string | null
  status: 'running' | 'completed' | 'stopped' | 'emergency' | 'interrupted'
  sampleCount: number
}
export type DeviceCommand =
  | { type: 'initialize' | 'home' | 'zero' | 'run' | 'stop' | 'emergency' | 'reset' | 'commitPressure' }
  | { type: 'toggle'; device: DeviceId }
  | { type: 'pressure'; value: number }
  | { type: 'database'; value: string }

export type ControllerMethod = 'hardware.motion.status' | 'hardware.motion.connect' | 'hardware.motion.stop' | 'hardware.motion.disconnect' | 'hardware.sensors.status' | 'hardware.sensors.connect' | 'hardware.sensors.disconnect' | 'hardware.sensors.zero' | 'hardware.sensors.records.list' | 'hardware.sensors.records.read' | 'hardware.status' | 'hardware.verify' | 'hardware.verify.cancel' | 'hardware.ports.list' | 'hardware.get' | 'hardware.save' | 'hardware.check' | 'state.get' | 'device.command' | 'config.get' | 'config.update' | 'logs.list' | 'records.list' | 'pressure.mode' | 'pressure.status' | 'pressure.zero.start' | 'pressure.zero.clear'
export const rendererMethods: readonly string[] = ['hardware.motion.status', 'hardware.motion.connect', 'hardware.motion.stop', 'hardware.motion.disconnect', 'hardware.sensors.status', 'hardware.sensors.connect', 'hardware.sensors.disconnect', 'hardware.sensors.zero', 'hardware.sensors.records.list', 'hardware.sensors.records.read', 'hardware.status', 'hardware.verify', 'hardware.verify.cancel', 'hardware.ports.list', 'hardware.get', 'hardware.save', 'hardware.check', 'state.get', 'device.command', 'config.get', 'config.update', 'logs.list', 'records.list', 'pressure.mode', 'pressure.status', 'pressure.zero.start', 'pressure.zero.clear']

export type ControllerEvent =
  | { event: 'pressure.frame'; data: PressureFrame }
  | { event: 'ready'; data: Snapshot }
  | { event: 'state'; data: LabState }
  | { event: 'config'; data: LabConfig }
  | { event: 'log'; data: LogEntry }
  | { event: 'offline'; data: { message: string } }

export interface AppInfo {
  version: string
  platform: string
  simulation: true
  dataDir: string
  configDir: string
  logsDir: string
  python: string
}
