import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { controllerDir, executable } from './build-controller.mjs'
import { copyControllerDirectory } from './copy-controller.mjs'

export function formatControllerExit(code, signal) {
  const status = code === null ? 'null' : `${code} (0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')})`
  return `exitCode=${status}, signal=${signal ?? 'none'}`
}

// Synchronous stderr markers survive a native runtime crash better than buffered
// console output, and identify which boundary was reached on the target machine.
function progress(message) {
  writeSync(2, `[controller:check] ${message}\n`)
}

export async function checkController() {
  progress(`runtime=${process.execPath}; Node=${process.versions.node}; platform=${process.platform}/${process.arch}; Bun=${process.versions.bun ?? 'none'}`)
  if (process.versions.bun) throw new Error('控制端检查需要官方 Node.js，请检查 node 命令是否被 Bun 替代，并使用 Node.js 24 LTS 重试')
  progress('创建中文/空格临时目录')
  const root = mkdtempSync(join(tmpdir(), '控制端 检查 '))
  let child
  let closed
  let timer
  try {
    const resources = join(root, '安装 资源', 'controller')
    progress(`复制完整控制端：${controllerDir} -> ${resources}`)
    copyControllerDirectory(controllerDir, resources)
    progress('控制端目录复制完成')
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
    delete env.PYTHONPATH
    delete env.PYTHONHOME
    delete env.LAB_PYTHON
    progress(`启动：${join(resources, executable)} --data-dir ${join(root, '用户 数据')}`)
    child = spawn(join(resources, executable), ['--data-dir', join(root, '用户 数据')], { env, stdio: 'pipe', windowsHide: true })
    closed = new Promise(resolveClose => child.once('close', resolveClose))
    child.once('spawn', () => progress(`子进程已创建，PID=${child.pid}，等待 ready`))
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const protocol = new Promise((resolveCheck, reject) => {
      const timeout = setTimeout(() => reject(new Error(`控制端检查超时：${stderr}`)), 15000)
      timer = timeout
      child.once('error', reject)
      child.stdin.on('error', reject)
      let stage = 'ready'
      let session
      const request = (method, id) => child.stdin.write(JSON.stringify({ v: 1, type: 'request', sessionId: session, id, method, params: {} }) + '\n')
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const message = JSON.parse(line)
          if (message.v !== 1) throw new Error('协议版本错误')
          if (stage === 'ready' && message.event === 'ready' && typeof message.sessionId === 'string') {
            session = message.sessionId; stage = 'ping'; progress('ready 握手通过，发送 system.ping'); request('system.ping', 'ping')
          } else if (message.type === 'response' && message.id === stage) {
            if (!message.ok || message.sessionId !== session) throw new Error('通信检查失败')
            if (stage === 'ping') { stage = 'shutdown'; progress('system.ping 通过，发送 system.shutdown'); request('system.shutdown', 'shutdown') }
            else { clearTimeout(timeout); progress('system.shutdown 响应通过，等待正常退出'); child.stdin.end(); resolveCheck() }
          }
        } catch (error) { reject(error) }
      })
    })
    await Promise.race([protocol, exited.then(async ([code, signal]) => {
      await closed
      throw new Error(`控制端提前退出：${formatControllerExit(code, signal)}；stderr=${stderr || '(empty)'}`)
    })])
    const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('控制端退出超时')), 5000) })])
    if (result[0] !== 0) throw new Error(`控制端退出异常：${formatControllerExit(...result)}；stderr=${stderr || '(empty)'}`)
    progress(`控制端已退出：${formatControllerExit(...result)}`)
  } finally {
    clearTimeout(timer)
    if (child) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
      await closed
    }
    progress(`清理临时目录：${root}`)
    rmSync(root, { recursive: true, force: true })
  }
  console.log('独立控制端：中文/空格路径、ready、system.ping、system.shutdown、进程退出通过；未发送运动指令')
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/check-controller.mjs')) await checkController()
