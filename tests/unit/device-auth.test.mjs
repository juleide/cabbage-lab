import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceDebugAuth, loadDeviceDebugAuth, DEVICE_AUTH_IDLE_MS } from '../../src/main/services/device-auth.ts'

test('debug authorization is window-bound, requires exact credentials and expires after inactivity', () => {
  let now = 0
  const auth = new DeviceDebugAuth('example-for-tests-only', () => now)
  assert.throws(() => auth.require(1), /未解锁/)
  assert.equal(auth.login(1, 'wrong').message, '密码错误')
  assert.equal(auth.login(1, 'example-for-tests-only').authorized, true)
  assert.equal(auth.status(2).authorized, false)
  now += DEVICE_AUTH_IDLE_MS - 1
  auth.touch(1)
  now += DEVICE_AUTH_IDLE_MS - 1
  assert.equal(auth.status(1).authorized, true)
  now++
  assert.throws(() => auth.require(1), /过期/)
  assert.equal(auth.touch(1).authorized, false)
  assert.equal(auth.login(2, 'example-for-tests-only').authorized, true)
  auth.lock()
  assert.equal(auth.status(2).authorized, false)
})

test('status polling never renews an idle authorization', () => {
  let now = 0
  const auth = new DeviceDebugAuth('example-for-tests-only', () => now)
  assert.equal(auth.login(1, 'example-for-tests-only').authorized, true)
  for (let i = 1; i <= 15; i++) {
    now = i * 60000
    assert.equal(auth.status(1).authorized, i < 15)
  }
  assert.equal(auth.touch(1).authorized, false)
})

test('five failures throttle all windows for 60 seconds and locks cannot bypass cooldown', () => {
  let now = 0
  const auth = new DeviceDebugAuth('example-for-tests-only', () => now)
  for (let i = 0; i < 5; i++) assert.equal(auth.login(1, 'wrong').authorized, false)
  assert.equal(auth.status(1).retryAfterSeconds, 60)
  auth.lock()
  assert.equal(auth.login(2, 'example-for-tests-only').authorized, false)
  now += 59999
  assert.equal(auth.status(1).retryAfterSeconds, 1)
  now++
  assert.equal(auth.login(1, 'example-for-tests-only').authorized, true)
  assert.equal(auth.status(1).retryAfterSeconds, 0)
  assert.equal(new DeviceDebugAuth('').status(1).configured, false)
  assert.equal(new DeviceDebugAuth().login(1, '').authorized, false)
  assert.equal(auth.login(1, {}).authorized, false)
  assert.equal(auth.login(1, 'x'.repeat(10000)).authorized, false)
})

test('env loading supports quoted credentials, overrides, missing config and fail-closed reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lab-auth-unit-'))
  try {
    const path = join(dir, '.env')
    assert.equal((await loadDeviceDebugAuth(path, {})).status(1).configured, false)
    await writeFile(path, 'LAB_DEVICE_DEBUG_USERNAME=engineer\nLAB_DEVICE_DEBUG_PASSWORD="spaces # quoted"\n')
    const auth = await loadDeviceDebugAuth(path, {})
    assert.equal(auth.login(1, 'spaces # quoted').authorized, true)
    const override = await loadDeviceDebugAuth(path, { LAB_DEVICE_DEBUG_USERNAME: 'other', LAB_DEVICE_DEBUG_PASSWORD: 'override-test-only' })
    assert.equal(override.login(1, 'override-test-only').authorized, true)
    assert.equal((await loadDeviceDebugAuth(path, { LAB_DEVICE_DEBUG_PASSWORD: '' })).status(1).configured, false)
    const unreadable = join(dir, 'directory')
    await mkdir(unreadable)
    assert.equal((await loadDeviceDebugAuth(unreadable, { LAB_DEVICE_DEBUG_USERNAME: 'x', LAB_DEVICE_DEBUG_PASSWORD: 'y' })).status(1).configured, false)
    assert.equal(JSON.stringify(auth.status(1)).includes('quoted'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('packaged credentials use only the encrypted package and ignore local overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lab-auth-bundled-'))
  try {
    const user = join(dir, 'user.env')
    const bundled = join(dir, 'device.env.enc')
    await writeFile(user, 'LAB_DEVICE_DEBUG_USERNAME=\nLAB_DEVICE_DEBUG_PASSWORD=\n')
    const { createCipheriv, createHmac, randomBytes } = await import('node:crypto')
    const key = randomBytes(32); const nonce = randomBytes(12)
    const payload = Buffer.from('1\nbundled # password', 'utf8')
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
    await writeFile(bundled, Buffer.concat([
      key, nonce, cipher.getAuthTag(),
      createHmac('sha256', key).update(encrypted).digest(), encrypted
    ]))
    const packaged = await loadDeviceDebugAuth(undefined, {}, bundled)
    assert.equal(packaged.login(1, 'bundled # password').authorized, true)
    const ignoredOverrides = await loadDeviceDebugAuth(undefined, { LAB_DEVICE_DEBUG_USERNAME: 'fake', LAB_DEVICE_DEBUG_PASSWORD: 'fake-only' }, bundled)
    assert.equal(ignoredOverrides.login(1, 'fake-only').authorized, false)
    const localOnly = await loadDeviceDebugAuth(user, {}, undefined)
    assert.equal(localOnly.login(1, 'local-only').authorized, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('credential files accept SHA-256 digests to avoid storing plaintext credentials', async () => {
  let now = 0
  const path = await mkdtemp(join(tmpdir(), 'lab-auth-digest-'))
  try {
    const file = join(path, '.env')
    const { createHash } = await import('node:crypto')
    const passwordDigest = createHash('sha256').update('digest-only-password').digest('hex')
    await writeFile(file, `LAB_DEVICE_DEBUG_PASSWORD=${passwordDigest}\n`)
    const auth = await loadDeviceDebugAuth(file, {}, undefined)
    assert.equal(auth.login(1, 'digest-only-password').authorized, true)
    now = 0
    assert.equal(auth.login(1, passwordDigest).authorized, false)
  } finally { await rm(path, { recursive: true, force: true }) }
})

test('password-only package preparation round-trips without a username; legacy packages fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lab-engineering-package-'))
  try {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const script = fileURLToPath(new URL('../../scripts/prepare-package-env.mjs', import.meta.url))
    await writeFile(join(dir, '.env'), 'LAB_DEVICE_DEBUG_PASSWORD=" package # password "\n')
    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const bundle = join(dir, 'resources/config/device.env.enc')
    const auth = await loadDeviceDebugAuth(undefined, {}, bundle)
    assert.equal(auth.status(1).configured, true)
    assert.equal(auth.login(1, ' package # password ').authorized, true)
    assert.equal(auth.login(1, 'engineer').authorized, false)
    const { createCipheriv, createHmac, randomBytes } = await import('node:crypto')
    const key = randomBytes(32), nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update('0\nengineer\npackage # password', 'utf8'), cipher.final()])
    await writeFile(bundle, Buffer.concat([key, nonce, cipher.getAuthTag(), createHmac('sha256', key).update(encrypted).digest(), encrypted]))
    assert.equal((await loadDeviceDebugAuth(undefined, {}, bundle)).status(1).configured, false)
    await writeFile(join(dir, '.env'), 'LAB_DEVICE_DEBUG_USERNAME=legacy-only\n')
    const empty = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
    assert.equal(empty.status, 0, empty.stderr)
    assert.equal((await loadDeviceDebugAuth(undefined, {}, bundle)).status(1).configured, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
