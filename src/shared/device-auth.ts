export interface DeviceAuthState {
  configured: boolean
  authorized: boolean
  retryAfterSeconds: number
  idleTimeoutMs: number
}
export interface DeviceAuthResult extends DeviceAuthState { message?: string }
