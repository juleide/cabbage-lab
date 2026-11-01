import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function legacyHardware() {
  const serial = (baud: number | null = null) => ({ port: '', baud, bits: 8, parity: 'N', stop: 1, timeoutMs: 1000, intervalMs: 100 })
  return { schemaVersion: 1, motors: { serial: { ...serial(9600), port: 'OFFLINE-CONFIG-ONLY' }, motor1: 1, motor2: 2 },
    lift: { serial: serial(38400), interface: 'RS232' },
    array: { mode: 'usb', press: { rev: 0, serial: serial() }, grip: { rev: 1, serial: serial() } },
    tension: { serial: serial(9600), station: null, unit: 'N', decimals: 0 },
    displacement: { serial: serial(9600), station: 1, model: '', channel: 1, reading: 'raw', rawMin: 0, rawMax: 5000, lower: null, upper: null, unit: 'mm' } }
}
async function enter(page: Page) {
  await expect(page.getByText('设备已就绪', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '设备连接', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
  await page.getByLabel('密码', { exact: true }).fill('motor-config-tests-only')
  await page.getByRole('button', { name: '进入', exact: true }).click()
  await page.getByRole('button', { name: '执行机构', exact: true }).click()
}
for (const unsupported of [false, true]) {
  test(`motor config migrates legacy ${unsupported ? 'unsupported values for correction' : 'without guessing run parameters'} and persists v2 without serial access`, async () => {
    const data = await mkdtemp(join(tmpdir(), 'lab-motor-config-'))
    const path = join(data, 'config', 'hardware.json')
    const marker = join(data, 'serial-imported')
    await mkdir(join(data, 'config'))
    const legacy = legacyHardware()
    if (unsupported) {
      legacy.motors.motor1 = 254
      legacy.motors.serial.baud = 57600
      legacy.motors.serial.bits = 7
    }
    const original = JSON.stringify(legacy)
    await writeFile(path, original)
    await writeFile(join(data, 'serial.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nraise AssertionError('Config must never import serial')\n`)
    const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, PYTHONPATH: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'motor-config-tests-only' } })
    try {
      const page = await app.firstWindow()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await enter(page)
      await expect(page.getByText(/已在内存中迁移旧配置/)).toBeVisible()
      expect(await readFile(path, 'utf8')).toBe(original)
      const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('hardware.get'))
      expect(snapshot.config.schemaVersion).toBe(2)
      expect(Object.values(snapshot.config.motors.operation.motor1).every(value => value === null)).toBe(true)
      const motor1 = page.getByRole('article', { name: '1 号电机固定运行参数', exact: true })
      const motor2 = page.getByRole('article', { name: '2 号电机固定运行参数', exact: true })
      await expect(motor1.getByLabel('运行速度（r/min）', { exact: true })).toBeEmpty()
      await expect(motor2.getByLabel('运行速度（r/min）', { exact: true })).toBeEmpty()
      if (unsupported) {
        await expect(page.getByLabel('1 号电机站号', { exact: true })).toHaveValue('254')
        await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('57600')
        await expect(page.getByRole('button', { name: '连接验证', exact: true })).toBeDisabled()
        await page.getByLabel('1 号电机站号', { exact: true }).fill('1')
        await page.getByLabel('波特率', { exact: true }).selectOption('9600')
        await page.getByText('高级通信参数', { exact: true }).click()
        await expect(page.getByLabel('串口格式', { exact: true })).toHaveValue('7N1')
        await page.getByLabel('串口格式', { exact: true }).selectOption('8N1')
      }
      await page.getByRole('button', { name: '检查电机配置', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '配置检查通过' })).toBeVisible()
      await motor1.getByLabel('1 号电机运行方向', { exact: true }).selectOption('-1')
      for (const [label, value] of Object.entries({ '运行速度（r/min）': '20', '安全速度上限（r/min）': '10', '加速时间（ms）': '100', '减速时间（ms）': '200', '单次最长运行（ms）': '5000' })) {
        await motor1.getByLabel(label, { exact: true }).fill(value)
      }
      await page.getByRole('button', { name: '检查电机配置', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '运行速度不得超过' })).toBeVisible()
      expect(await readFile(path, 'utf8')).toBe(original)
      await motor1.getByLabel('运行速度（r/min）', { exact: true }).fill('5')
      await page.getByRole('button', { name: '保存草稿', exact: true }).click()
      await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible()
      const saved = JSON.parse(await readFile(path, 'utf8'))
      expect(saved.schemaVersion).toBe(2)
      expect(saved.motors.operation.motor1).toEqual({ direction: -1, speedRpm: 5, maxSpeedRpm: 10, accelerationMs: 100, decelerationMs: 200, maxRunMs: 5000 })
      expect(Object.values(saved.motors.operation.motor2).every(value => value === null)).toBe(true)
      await page.reload()
      await enter(page)
      await expect(page.getByRole('article', { name: '1 号电机固定运行参数', exact: true }).getByLabel('运行速度（r/min）', { exact: true })).toHaveValue('5')
      await expect(page.getByText(/已在内存中迁移旧配置/)).toHaveCount(0)
      await expect(page.getByRole('article', { name: '2 号电机固定运行参数', exact: true }).getByLabel('运行速度（r/min）', { exact: true })).toBeEmpty()
      await expect(page.getByRole('button', { name: '连接验证', exact: true })).toBeDisabled()
      await page.getByRole('button', { name: '检查电机配置', exact: true }).click()
      await expect(page.getByRole('button', { name: '连接验证', exact: true })).toBeEnabled()
      await expect(page.getByLabel('共用串口', { exact: true })).toHaveCount(1)
      await expect(page.getByLabel('1 号电机站号', { exact: true })).toHaveCount(1)
      await expect(page.getByLabel('2 号电机站号', { exact: true })).toHaveCount(1)
      expect(errors).toEqual([])
      await expect(access(marker)).rejects.toThrow()
      await motor1.screenshot({ path: `/tmp/cabbage-motor-config-${unsupported ? 'legacy' : 'normal'}.png` })
    } finally {
      await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await app.close().catch(() => {})
      await rm(data, { recursive: true, force: true })
    }
  })
}
