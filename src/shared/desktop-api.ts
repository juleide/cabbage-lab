import type { DeviceAuthResult, DeviceAuthState } from './device-auth'
import type { AppInfo, ControllerEvent, ControllerMethod, DisplayRange, Theme } from './controller'

export type ExportResult =
  | { saved: false; count: 0; fileCount: 0 }
  | { saved: true; count: number; fileCount: number; outputPath: string; outputKind: 'file' | 'directory' }

/** Only whitelisted device operations and fixed desktop capabilities cross the bridge. */
export interface DesktopAPI {
  getDeviceDebugAuth(): Promise<DeviceAuthState>
  loginDeviceDebug(password: string): Promise<DeviceAuthResult>
  lockDeviceDebug(): Promise<void>
  touchDeviceDebug(): Promise<DeviceAuthState>
  onDeviceDebugLocked(callback: () => void): () => void
  request<T = unknown>(method: ControllerMethod, params?: Record<string, unknown>): Promise<T>
  subscribe(callback: (event: ControllerEvent) => void): () => void
  restartController(): Promise<void>
  info(): Promise<AppInfo>
  openDirectory(kind: 'data' | 'logs' | 'config'): Promise<void>
  exportRecords(runId?: string): Promise<ExportResult>
  getDisplayRange(): Promise<DisplayRange>
  setDisplayRange(range: DisplayRange): Promise<void>
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
}
