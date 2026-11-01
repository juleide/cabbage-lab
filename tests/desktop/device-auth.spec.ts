import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function enter(page: Page) {
  await expect(page.getByText('设备已就绪', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '设备连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设备调试', exact: true })).toBeVisible()
}
async function login(page: Page, password = 'auth-desktop-tests-only') {
  await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入', exact: true }).click()
}
async function denied(page: Page) {
  for (const method of ['hardware.motion.status', 'hardware.motion.connect', 'hardware.motion.stop', 'hardware.motion.disconnect', 'hardware.get', 'hardware.save', 'hardware.check', 'hardware.ports.list', 'hardware.status', 'hardware.verify', 'hardware.verify.cancel', 'hardware.sensors.status', 'hardware.sensors.connect', 'hardware.sensors.disconnect', 'hardware.sensors.zero', 'hardware.sensors.records.list', 'hardware.sensors.records.read']) {
    const result = await page.evaluate(async method => {
      try { await window.labDesktop!.request(method as any, {}); return 'unexpected-success' }
      catch (error) { return (error as Error).message }
    }, method)
    expect(result).toContain('研发调试未解锁或已过期')
  }
}

test('debug login protects IPC, relocks on exit/reload and preserves a draft on idle timeout', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-debug-auth-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'auth-desktop-tests-only' } })
  try {
    const page = await app.firstWindow()
    await enter(page)
    expect(await app.evaluate(() => [process.env.LAB_DEVICE_DEBUG_USERNAME, process.env.LAB_DEVICE_DEBUG_PASSWORD])).toEqual([undefined, undefined])
    await denied(page)
    await expect(page.getByRole('button', { name: '执行机构', exact: true })).toHaveCount(0)
    await page.getByLabel('密码', { exact: true }).fill('not-a-real-secret')
    await page.getByRole('button', { name: '显示密码', exact: true }).click()
    await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text')
    await login(page, 'wrong-test-password')
    await expect(page.locator('.device-auth-page').getByRole('status')).toContainText('用户名或密码错误')
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
    await login(page)
    await expect(page.getByRole('button', { name: '执行机构', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    await page.getByLabel('1 号电机站号', { exact: true }).fill('7')
    // Advance only this disposable application's monotonic clock, not the system clock.
    await app.evaluate(() => {
      const now = performance.now.bind(performance)
      ;(globalThis as any).__authTestClock = now
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 14 * 60000 })
    })
    await page.evaluate(async () => {
      await window.labDesktop!.request('hardware.motion.status')
      await window.labDesktop!.request('hardware.sensors.status')
      await window.labDesktop!.request('hardware.status')
    })
    await app.evaluate(() => {
      const now = (globalThis as any).__authTestClock as () => number
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 16 * 60000 })
    })
    try {
      const expired = await page.evaluate(() => window.labDesktop!.getDeviceDebugAuth())
      expect(expired.authorized).toBe(false)
    } finally {
      await app.evaluate(() => { delete (performance as any).now; delete (globalThis as any).__authTestClock })
    }
    await expect(page.getByRole('heading', { name: '设备调试', exact: true })).toBeVisible()
    await expect(page.getByLabel('1 号电机站号', { exact: true })).toBeHidden()
    await denied(page)
    await login(page)
    await expect(page.getByLabel('1 号电机站号', { exact: true })).toHaveValue('7')
    await page.evaluate(() => { (window as any).__confirm = window.confirm; window.confirm = () => true })
    await page.getByRole('button', { name: '外观与主题', exact: true }).click()
    await page.evaluate(() => { window.confirm = (window as any).__confirm })
    await expect(page.getByRole('heading', { name: '外观与主题', exact: true })).toBeVisible()
    await denied(page)
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await login(page)
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设备调试', exact: true })).toBeVisible()
    await denied(page)
    await page.screenshot({ path: '/tmp/cabbage-device-auth.png', fullPage: true })
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})

test('missing credentials fail closed; five failures impose cooldown across refresh', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-debug-limit-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'auth-desktop-tests-only' } })
  try {
    const page = await app.firstWindow()
    await enter(page)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.labDesktop!.loginDeviceDebug('test-engineer', 'wrong-test-password'))
    }
    await expect(page.locator('.device-auth-page').getByRole('status')).toContainText('秒后重试')
    await expect(page.getByRole('button', { name: '进入', exact: true })).toBeDisabled()
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await expect(page.locator('.device-auth-page').getByRole('status')).toContainText('秒后重试')
    const result = await page.evaluate(() => window.labDesktop!.loginDeviceDebug('test-engineer', 'auth-desktop-tests-only'))
    expect(result.authorized).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
    await denied(page)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
  const missing = await mkdtemp(join(tmpdir(), 'lab-debug-missing-'))
  const other = await electron.launch({ args: ['.', `--user-data-dir=${join(missing, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: missing, LAB_DEVICE_DEBUG_USERNAME: '', LAB_DEVICE_DEBUG_PASSWORD: '' } })
  try {
    const page = await other.firstWindow()
    await enter(page)
    await expect(page.locator('.device-auth-page').getByRole('status')).toContainText('未配置研发调试凭据')
    await expect(page.getByRole('button', { name: '进入', exact: true })).toBeDisabled()
    await denied(page)
  } finally {
    await other.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await other.close().catch(() => {})
    await rm(missing, { recursive: true, force: true })
  }
})
