import assert from 'node:assert/strict'
import test from 'node:test'
import * as modules from 'node:module'
import ts from 'typescript'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

// Only the OS process boundary and Electron runtime are mocked; production
// ControllerProcess still handles JSONL, startup errors and shutdown itself.
test('development and installed controller launch contracts', { skip: !modules.registerHooks }, async t => {
  const root = mkdtempSync(join(tmpdir(), '控制 启动 '))
  const previousResources = process.resourcesPath
  const previousPython = process.env.LAB_PYTHON
  const previousPath = process.env.PYTHONPATH
  process.resourcesPath = root
  process.env.LAB_PYTHON = 'deliberately missing system python'
  process.env.PYTHONPATH = 'developer-only-path'
  const app = { isPackaged: true, getAppPath: () => root }
  const calls = []
  let mode = 'ready'
  let lastChild
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    lastChild = child
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null })
    child.kill = signal => {
      if (child.exitCode === null && !child.signalCode) {
        child.signalCode = signal || 'SIGTERM'
        child.emit('exit', null, child.signalCode)
      }
      return true
    }
    const send = message => child.stdout.write(JSON.stringify({ v: 1, sessionId: 'test-session', ...message }) + '\n')
    child.stdin.on('data', data => {
      const request = JSON.parse(data.toString())
      send({ type: 'response', id: request.id, ok: true, result: { online: true } })
    })
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0, null) })
    setImmediate(() => {
      if (mode === 'ready') send({ type: 'event', event: 'ready', data: {} })
      else if (mode === 'error') child.emit('error', new Error('ENOENT fixture'))
    })
    return child
  }
  globalThis.__controllerLaunchTest = { app, spawn }
  const hook = modules.registerHooks({
    load(url, context, next) {
      if (url.endsWith('/src/main/services/controller.ts')) {
        const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        return { format: 'module', source, shortCircuit: true }
      }
      return next(url, context)
    },
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/src/main/services/controller.ts') && ['electron', 'node:child_process'].includes(specifier)) {
        const source = specifier === 'electron' ? 'export const app = globalThis.__controllerLaunchTest.app' : 'export const spawn = globalThis.__controllerLaunchTest.spawn'
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      }
      return next(specifier, context)
    }
  })
  try {
    const { ControllerProcess } = await import('../../src/main/services/controller.ts')
    const exe = join(root, 'controller', process.platform === 'win32' ? 'lab-controller.exe' : 'lab-controller')
    await t.test('missing built-in executable fails without spawning Python', async () => {
      const service = new ControllerProcess(join(root, '用户 数据'))
      const events = []
      service.on('event', event => events.push(event))
      await assert.rejects(service.start(), /内置控制端缺失/)
      assert.equal(calls.length, 0)
      assert.equal(events[0].event, 'offline')
    })
    mkdirSync(join(root, 'controller'))
    writeFileSync(exe, 'fixture')
    await t.test('packaged launch ignores LAB_PYTHON and source path, preserves pipes and shutdown', async () => {
      const service = new ControllerProcess(join(root, '用户 数据'))
      await service.start()
      assert.equal(service.python, exe)
      const call = calls.at(-1)
      assert.equal(call.command, exe)
      assert.deepEqual(call.args, ['--data-dir', service.root])
      assert.equal(call.options.stdio, 'pipe')
      assert.equal(call.options.windowsHide, true)
      for (const name of ['LAB_PYTHON', 'PYTHONPATH', 'PYTHONHOME', 'LAB_DEVICE_DEBUG_USERNAME', 'LAB_DEVICE_DEBUG_PASSWORD']) assert.equal(call.options.env[name], undefined)
      assert.deepEqual(await service.request('system.ping'), { online: true })
      await service.stop()
      assert.equal(service.online, false)
      assert.equal(lastChild.exitCode, 0)
    })
    await t.test('spawn failure has an installed-app error and never falls back', async () => {
      mode = 'error'
      const count = calls.length
      await assert.rejects(new ControllerProcess(root).start(), /内置控制端无法启动.*ENOENT/)
      assert.equal(calls.length, count + 1)
    })
    await t.test('handshake timeout has no install-Python instruction or fallback', async () => {
      mode = 'silent'
      const original = globalThis.setTimeout
      globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 10000 ? 5 : delay, ...args)
      try {
        const count = calls.length
        await assert.rejects(new ControllerProcess(root).start(), /内置控制端握手超时/)
        assert.equal(calls.length, count + 1)
        assert.equal(lastChild.signalCode, 'SIGTERM')
      } finally { globalThis.setTimeout = original }
    })
    await t.test('development retains module startup and interpreter override', async () => {
      app.isPackaged = false
      mode = 'ready'
      const service = new ControllerProcess(root)
      await service.start()
      const call = calls.at(-1)
      assert.equal(call.command, process.env.LAB_PYTHON)
      assert.deepEqual(call.args, ['-m', 'lab_controller', '--data-dir', root])
      assert.equal(call.options.env.PYTHONPATH, `${join(root, 'backend/src')}${delimiter}developer-only-path`)
      await service.stop()
    })
  } finally {
    hook.deregister()
    delete globalThis.__controllerLaunchTest
    if (previousResources === undefined) delete process.resourcesPath
    else process.resourcesPath = previousResources
    for (const [name, value] of [['LAB_PYTHON', previousPython], ['PYTHONPATH', previousPath]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
