import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { controllerDir, executable } from './build-controller.mjs'

export async function checkController() {
  const root = mkdtempSync(join(tmpdir(), '控制端 检查 '))
  let child
  let closed
  let timer
  try {
    const resources = join(root, '安装 资源', 'controller')
    cpSync(controllerDir, resources, { recursive: true, verbatimSymlinks: true })
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
    delete env.PYTHONPATH
    delete env.PYTHONHOME
    delete env.LAB_PYTHON
    child = spawn(join(resources, executable), ['--data-dir', join(root, '用户 数据')], { env, stdio: 'pipe', windowsHide: true })
    closed = new Promise(resolveClose => child.once('close', resolveClose))
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
            session = message.sessionId; stage = 'ping'; request('system.ping', 'ping')
          } else if (message.type === 'response' && message.id === stage) {
            if (!message.ok || message.sessionId !== session) throw new Error('通信检查失败')
            if (stage === 'ping') { stage = 'shutdown'; request('system.shutdown', 'shutdown') }
            else { clearTimeout(timeout); child.stdin.end(); resolveCheck() }
          }
        } catch (error) { reject(error) }
      })
    })
    await Promise.race([protocol, exited.then(() => { throw new Error(`控制端提前退出：${stderr}`) })])
    const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('控制端退出超时')), 5000) })])
    if (result[0] !== 0) throw new Error(`控制端退出异常：${stderr}`)
    console.log('独立控制端：中文/空格路径、ready、system.ping、system.shutdown、进程退出通过；未发送运动指令')
  } finally {
    clearTimeout(timer)
    if (child) {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
      await closed
    }
    rmSync(root, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/check-controller.mjs')) await checkController()
