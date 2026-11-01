import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
    writeFileSync(binary, fixture(false))
    const rejected = run()
    assert.equal(rejected.status, 1, rejected.stderr)
    assert.match(rejected.stderr, /通信检查失败/)
    rmSync(binary)
    const missing = run()
    assert.equal(missing.status, 1, missing.stderr)
    assert.match(missing.stderr, /ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
