import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('continuous sensors show quality, preserve metric mapping boundaries and provide separate records', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-sensors-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'sensor-tests-only' } })
  try {
    const page = await app.firstWindow()
    page.on('dialog', dialog => { void dialog.accept() })
    await expect(page.getByText(/设备未就绪|设备异常/, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
    await page.getByLabel('密码', { exact: true }).fill('sensor-tests-only')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByRole('button', { name: '拉力与位移', exact: true }).click()
    await page.getByLabel('串口', { exact: true }).fill('TEST1')
    await page.getByLabel('实际站号', { exact: true }).fill('1')
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis as any
      fixture.__sensorQuality = 'valid'
      let connected = false
      const sample = { number: 1, kind: 'sample', source: 'hardware', section: 'tension', sessionId: 'test-session', quality: 'valid', raw: 1234, value: 12.34, absoluteValue: 12.34, zeroOffset: 0, unit: 'N', receivedAt: Date.now() / 1000 }
      const snapshot = () => ({ tension: {
        sessionId: 'test-session', section: 'tension', source: 'hardware', state: connected ? 'collecting' : 'disconnected',
        quality: connected ? fixture.__sensorQuality : 'unavailable', reading: connected && fixture.__sensorQuality === 'valid' ? sample : null,
        lastValid: sample, error: null, configVersion: 'test-version', zeroOffset: 0, startedAt: sample.receivedAt,
        finishedAt: connected ? null : Date.now() / 1000, staleAfterMs: 1000
      } })
      ipcMain.removeHandler('controller:request')
      ipcMain.handle('controller:request', (_event, method, params) => {
        if (method === 'hardware.sensors.connect') {
          if (params.section !== 'tension') throw new Error('Unexpected sensor')
          connected = true
          return snapshot()
        }
        if (method === 'hardware.sensors.disconnect') { connected = false; return snapshot() }
        if (method === 'hardware.motion.status') return {}
        if (method === 'hardware.sensors.status') return snapshot()
        if (method === 'hardware.sensors.records.list') return [{ id: 'test-session', section: 'tension', source: 'hardware', startedAt: sample.receivedAt, endedAt: Date.now() / 1000, status: 'completed', configVersion: 'test-version', config: {}, error: null, eventCount: 2 }]
        if (method === 'hardware.sensors.records.read') return [sample, { ...sample, number: 2, kind: 'end', quality: 'unavailable', raw: null, value: null }]
        throw new Error('Unexpected test request: ' + method)
      })
    })
    const panel = page.getByRole('article', { name: '拉力持续采集', exact: true })
    await panel.getByRole('button', { name: '连接拉力并采集', exact: true }).click()
    await expect(panel.getByText('持续采集中', { exact: true })).toBeVisible()
    await expect(panel.locator('.hw-sensor-value')).toContainText('12.34')
    await expect(page.getByLabel('串口', { exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '连接验证', exact: true })).toBeDisabled()
    await expect(page.getByText('真实硬件连接', { exact: true })).toBeVisible()
    await app.evaluate(() => { (globalThis as any).__sensorQuality = 'stale' })
    await expect(panel.getByText(/数据质量：已过期/)).toBeVisible()
    await expect(panel.locator('.hw-sensor-value')).toContainText('—')
    await expect(panel.getByText(/历史，非当前值/)).toBeVisible()
    await expect(page.getByRole('button', { name: '位移相对置零', exact: true })).toBeDisabled()
    await panel.getByRole('button', { name: '断开拉力', exact: true }).click()
    await expect(panel.getByText('已断开', { exact: true })).toBeVisible()
    await expect(page.getByLabel('串口', { exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '刷新真实采集记录', exact: true }).click()
    await page.getByLabel('真实采集记录', { exact: true }).selectOption('test-session')
    await expect(page.getByRole('cell', { name: /12.34 N \/ 1234/ })).toBeVisible()
    await expect(page.getByRole('cell', { name: '2 / 结束', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    await page.getByRole('table').scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/cabbage-sensor-records.png', fullPage: true })
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
