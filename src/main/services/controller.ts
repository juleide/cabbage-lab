import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, appendFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import type { ControllerEvent } from '../../shared/controller'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** One Python session at a time. Device actions are never retried automatically. */
export class ControllerProcess extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private session?: string
  private pending = new Map<string, Pending>()
  private heartbeat?: NodeJS.Timeout
  private starting?: Promise<void>
  private stopping = false

  constructor(readonly root: string) { super() }
  get online() { return !!this.session }
  get python() {
    return process.env.LAB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.child) return Promise.reject(new Error('旧控制进程尚未退出'))
    this.stopping = false
    const startup = new Promise<void>((resolveStart, rejectStart) => {
      const source = app.isPackaged
        ? join(process.resourcesPath, 'backend', 'src')
        : join(app.getAppPath(), 'backend', 'src')
      const child = spawn(this.python, ['-m', 'lab_controller', '--data-dir', this.root], {
        stdio: 'pipe', windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(delimiter) }
      })
      this.child = child
      let failed = false
      const fail = (error: Error) => {
        if (failed) return
        failed = true
        clearTimeout(startupTimer)
        clearInterval(this.heartbeat)
        this.session = undefined
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(error)
        }
        this.pending.clear()
        rejectStart(error)
        this.emit('event', { event: 'offline', data: { message: error.message } } satisfies ControllerEvent)
      }
      const startupTimer = setTimeout(() => {
        fail(new Error('Python 控制端启动超时，请检查 Python 3.10+ 和日志'))
        child.kill()
      }, 10_000)
      child.on('error', error => { fail(error); if (this.child === child) this.child = undefined })
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = undefined
        fail(new Error(this.stopping ? '控制进程已停止' : `控制进程退出（${code ?? signal}），设备状态未知`))
      })
      child.stdin.on('error', error => { fail(error); child.kill() })
      child.stderr.on('data', (data: Buffer) => {
        try {
          const file = join(this.root, 'logs', 'desktop-controller.log')
          // Python owns the rotating operational log; stderr is only for startup failures.
          if (existsSync(join(this.root, 'logs'))) appendFileSync(file, data)
        } catch { /* A full disk must not prevent process shutdown. */ }
      })
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed) return
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
          fail(new Error('控制端消息超限')); child.kill(); return
        }
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          try {
            if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('控制端消息超限')
            const message = JSON.parse(line)
            if (message.v !== 1 || typeof message.sessionId !== 'string') throw new Error('不兼容的控制端协议')
            if (message.type === 'event' && message.event === 'ready') {
              if (this.session) throw new Error('重复的控制端就绪事件')
              this.session = message.sessionId
              clearTimeout(startupTimer)
              this.heartbeat = setInterval(() => {
                void this.request('system.ping').catch((error: Error) => { fail(error); child.kill() })
              }, 2000)
              this.emit('event', { event: 'ready', data: message.data } satisfies ControllerEvent)
              resolveStart()
              continue
            }
            if (message.sessionId !== this.session) continue
            if (message.type === 'response') {
              const request = this.pending.get(message.id)
              if (!request) continue
              clearTimeout(request.timer)
              this.pending.delete(message.id)
              if (message.ok) request.resolve(message.result)
              else request.reject(new Error(message.error?.message || '控制操作失败'))
            } else if (message.type === 'event' && ['state', 'config', 'log', 'pressure.frame'].includes(message.event)) {
              this.emit('event', { event: message.event, data: message.data } as ControllerEvent)
            } else throw new Error('无效的控制端消息')
          } catch (error) {
            fail(error as Error); child.kill(); return
          }
        }
      })
    })
    this.starting = startup
    void startup.finally(() => { this.starting = undefined }).catch(() => {})
    return startup
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const child = this.child
    if (!this.session || !child || child.stdin.destroyed) return Promise.reject(new Error('控制端未连接，设备状态未知'))
    const urgent = method === 'system.shutdown' || method === 'system.suspend' || (method === 'device.command' && ['emergency', 'stop'].includes(String(params.type)))
    if (this.pending.size >= 64 && !urgent) return Promise.reject(new Error('操作队列已满，请稍后再试'))
    const id = randomUUID()
    const data = JSON.stringify({ v: 1, type: 'request', sessionId: this.session, id, method, params }) + '\n'
    if (Buffer.byteLength(data) > 1024 * 1024) return Promise.reject(new Error('请求消息超限'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('操作超时，请确认设备状态，不要重复启动动作'))
      }, 5000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.stdin.write(data, 'utf8', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }

  async stop() {
    this.stopping = true
    clearInterval(this.heartbeat)
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode) return
    try { if (this.online) await this.request('system.shutdown') } catch { /* EOF also stops Python. */ }
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode) return
    await new Promise<void>((resolve, reject) => {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 2000)
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
      const timeout = setTimeout(() => { clearTimeout(terminate); clearTimeout(kill); reject(new Error('旧控制端未退出，请检查系统进程')) }, 5000)
      child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); clearTimeout(timeout); resolve() })
    })
  }
}
