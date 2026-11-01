import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { formatControllerExit } from '../../scripts/check-controller.mjs'

// A disposable JSONL fixture tests the checker itself, NOT the frozen backend.
// Unix shebang fixtures are not Windows executables; real Windows verification
// must run against the native PyInstaller artifact.
test('communication checker accepts only ready/ping/shutdown and handles failed spawn', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), '通信 检查器 '))
  const script = new URL('../../scripts/check-controller.mjs', import.meta.url).href
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `await (await import(${JSON.stringify(script)})).checkController()`], { cwd: root, encoding: 'utf8', timeout: 10000 })
  try {
    const dir = join(root, 'dist/controller/lab-controller')
    mkdirSync(dir, { recursive: true })
    const binary = join(dir, 'lab-controller')
    const fixture = success => `#!${process.execPath}
const readline = require('node:readline')
const send = message => console.log(JSON.stringify({ v: 1, sessionId: 'fixture', ...message }))
send({ type: 'event', event: 'ready' })
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!['system.ping', 'system.shutdown'].includes(message.method)) process.exit(9)
  send({ type: 'response', id: message.id, ok: ${success} })
  if (message.method === 'system.shutdown') process.exitCode = 0
})
`
    writeFileSync(binary, fixture(true)); chmodSync(binary, 0o755)
    const success = run()
    assert.equal(success.status, 0, success.stderr)
    assert.match(success.stdout, /进程退出通过/)
    for (const marker of ['runtime=', '复制完整控制端', '控制端目录复制完成', '子进程已创建', 'ready 握手通过', 'system.ping 通过', 'system.shutdown 响应通过', '控制端已退出', '清理临时目录']) assert.ok(success.stderr.includes(marker), marker)
    writeFileSync(binary, fixture(false))
    const rejected = run()
    assert.equal(rejected.status, 1, rejected.stderr)
    assert.match(rejected.stderr, /通信检查失败/)
    writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('native failure fixture'); process.exit(23)\n`)
    const exited = run()
    assert.equal(exited.status, 1, exited.stderr)
    assert.match(exited.stderr, /控制端提前退出：exitCode=23 \(0x00000017\)/)
    assert.match(exited.stderr, /native failure fixture/)
    rmSync(binary)
    const missing = run()
    assert.equal(missing.status, 1, missing.stderr)
    assert.match(missing.stderr, /ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('Windows native exit status is preserved as decimal and hexadecimal', () => {
  assert.equal(formatControllerExit(3221225477, null), 'exitCode=3221225477 (0xC0000005), signal=none')
  assert.equal(formatControllerExit(-1073741819, null), 'exitCode=-1073741819 (0xC0000005), signal=none')
  assert.equal(formatControllerExit(null, 'SIGTERM'), 'exitCode=null, signal=SIGTERM')
})

test('Bun masquerading as node is rejected before copying or launching the backend', () => {
  const script = new URL('../../scripts/check-controller.mjs', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process.versions, 'bun', { value: 'fixture' });
    await (await import(${JSON.stringify(script)})).checkController();
  `], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /检查需要官方 Node.js/)
  assert.doesNotMatch(result.stderr, /复制完整控制端：/)
})
