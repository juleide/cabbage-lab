import { createHash, timingSafeEqual } from 'node:crypto'
import { createDecipheriv, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import type { DeviceAuthResult, DeviceAuthState } from '../../shared/device-auth.ts'

export const DEVICE_AUTH_IDLE_MS = 15 * 60 * 1000
const COOLDOWN_MS = 60 * 1000
const MAX_ATTEMPTS = 5
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
const isSha256Hex = (value: string | undefined) => /^[0-9a-f]{64}$/i.test(value ?? '')

/** Main-process memory only. Neither credentials nor sessions cross into Python. */
export class DeviceDebugAuth {
  private password?: Buffer
  private owner?: number
  private expiresAt = 0
  private failures = 0
  private blockedUntil = 0
  private readonly clock: () => number

  constructor(password?: string, clock = () => performance.now()) {
    this.clock = clock
    if (password?.trim() && password.length <= 1024) {
      this.password = isSha256Hex(password) ? Buffer.from(password.toLowerCase(), 'hex') : digest(password)
    }
  }

  status(owner: number): DeviceAuthState {
    if (this.clock() >= this.expiresAt) this.lock()
    return {
      configured: !!this.password,
      authorized: this.owner !== undefined && this.owner === owner,
      retryAfterSeconds: Math.max(0, Math.ceil((this.blockedUntil - this.clock()) / 1000)),
      idleTimeoutMs: DEVICE_AUTH_IDLE_MS
    }
  }

  login(owner: number, password: unknown): DeviceAuthResult {
    this.lock()
    const state = this.status(owner)
    if (!state.configured) return { ...state, message: '未配置工程模式密码，请联系管理员' }
    if (state.retryAfterSeconds) return { ...state, message: '尝试次数过多，请稍后重试' }
    // After cooldown, grant a new group of attempts; refresh/lock never resets failures.
    if (this.blockedUntil) { this.blockedUntil = 0; this.failures = 0 }
    const valid = typeof password === 'string' && password.length <= 1024
    const passwordMatches = timingSafeEqual(digest(valid ? password : ''), this.password!)
    if (!valid || !passwordMatches) {
      if (++this.failures >= MAX_ATTEMPTS) this.blockedUntil = this.clock() + COOLDOWN_MS
      return { ...this.status(owner), message: '密码错误' }
    }
    this.failures = 0
    this.owner = owner
    this.expiresAt = this.clock() + DEVICE_AUTH_IDLE_MS
    return this.status(owner)
  }

  require(owner: number) {
    if (!this.status(owner).authorized) throw new Error('研发调试未解锁或已过期，请重新验证身份')
  }

  touch(owner: number): DeviceAuthState {
    if (this.status(owner).authorized) this.expiresAt = this.clock() + DEVICE_AUTH_IDLE_MS
    return this.status(owner)
  }

  lock() { this.owner = undefined; this.expiresAt = 0 }
}

/** Development uses .env and process overrides; packaged builds ignore both and use encrypted credentials only. */
export async function loadDeviceDebugAuth(filename: string | undefined, environment: NodeJS.ProcessEnv, bundledFilename?: string): Promise<DeviceDebugAuth> {
  let file: Record<string, string | undefined> = {}
  if (filename) {
    try { file = parseEnv(await readFile(filename, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return new DeviceDebugAuth()
    }
  }
  const fromFile = (value: string | undefined) => value?.trim() ? value : undefined
  let bundled: Record<string, string | undefined> = {}
  if (bundledFilename) {
    try { bundled = await readPackagedCredentials(bundledFilename) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return new DeviceDebugAuth()
    }
  }
  const resolveValue = (environmentValue: string | undefined, fileValue: string | undefined, bundledValue: string | undefined) => {
    const source = bundledFilename ? fromFile(bundledValue) : environmentValue ?? fromFile(fileValue)
    return source
  }
  return new DeviceDebugAuth(
    resolveValue(environment.LAB_DEVICE_DEBUG_PASSWORD, file.LAB_DEVICE_DEBUG_PASSWORD, bundled.LAB_DEVICE_DEBUG_PASSWORD)
  )
}

async function readPackagedCredentials(filename: string): Promise<Record<string, string | undefined>> {
  const package_ = await readFile(filename)
  if (package_.length === 0) return {}
  const key = package_.subarray(0, 32)
  const nonce = package_.subarray(32, 44)
  const tag = package_.subarray(44, 60)
  const checksum = package_.subarray(60, 92)
  const encrypted = package_.subarray(92)
  if (!timingSafeEqual(createHmac('sha256', key).update(encrypted).digest(), checksum)) throw new Error('打包凭据校验失败')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const [version, password = ''] = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').split('\n')
  if (version !== '1' || !password) throw new Error('打包凭据格式无效')
  return { LAB_DEVICE_DEBUG_PASSWORD: password }
}

