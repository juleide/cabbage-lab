import type { AppInfo, ControllerEvent, ControllerMethod, DisplayRange, Theme } from './controller'

/** Only whitelisted device operations and fixed desktop capabilities cross the bridge. */
export interface DesktopAPI {
  request<T = unknown>(method: ControllerMethod, params?: Record<string, unknown>): Promise<T>
  subscribe(callback: (event: ControllerEvent) => void): () => void
  restartController(): Promise<void>
  info(): Promise<AppInfo>
  openDirectory(kind: 'data' | 'logs' | 'config'): Promise<void>
  exportRecords(runId?: string): Promise<{ saved: boolean; count: number }>
  getDisplayRange(): Promise<DisplayRange>
  setDisplayRange(range: DisplayRange): Promise<void>
  getTheme(): Promise<Theme>
  setTheme(theme: Theme): Promise<void>
}
