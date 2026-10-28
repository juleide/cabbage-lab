export type DeviceId = 'motor1' | 'motor2' | 'lift'
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
export interface LabState {
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

export type ControllerMethod = 'state.get' | 'device.command' | 'config.get' | 'config.update' | 'logs.list' | 'records.list'
export const rendererMethods: readonly string[] = ['state.get', 'device.command', 'config.get', 'config.update', 'logs.list', 'records.list']

export type ControllerEvent =
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
