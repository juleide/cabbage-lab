import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const serial = (port = '', baud: number | null = null) => ({ port, baud, bits: 8, parity: 'N', stop: 1, timeoutMs: 1000, intervalMs: 100 })
function hardware() {
  return { schemaVersion: 1, motors: { serial: serial('OFFLINE-MOTORS', 9600), motor1: 1, motor2: 2 },
    lift: { serial: serial('OFFLINE-LIFT', 38400), interface: 'RS232' },
    array: { mode: 'usb', press: { rev: 0, serial: serial() }, grip: { rev: 1, serial: serial() } },
    tension: { serial: serial('', 9600), station: null, unit: 'N', decimals: 0 },
    displacement: { serial: serial('', 9600), station: 1, model: '', channel: 1, reading: 'raw', rawMin: 0, rawMax: 5000, lower: null, upper: null, unit: 'mm' } }
}
async function enter(page: Page) {
  await expect(page.getByText(/设备未就绪|设备异常/, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '设备连接', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
  await page.getByLabel('密码', { exact: true }).fill('safety-tests-only')
  await page.getByRole('button', { name: '进入', exact: true }).click()
  await page.getByRole('button', { name: '运动安全', exact: true }).click()
  await expect(page.getByRole('heading', { name: '运动安全草稿与能力评估', exact: true })).toBeVisible()
}

test('safety draft saves via real IPC, plans offline and invalidates after connection changes', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-safety-'))
  const marker = join(data, 'serial-imported')
  await mkdir(join(data, 'config'))
  await writeFile(join(data, 'config', 'hardware.json'), JSON.stringify(hardware()))
  await writeFile(join(data, 'serial.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).open('a').write('import\\n')\nraise AssertionError('Offline planning must not import serial')\n`)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, PYTHONPATH: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'safety-tests-only' } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const accept = (dialog: any) => { void dialog.accept().catch(() => {}) }
    page.on('dialog', accept)
    await enter(page)
    const startupSerialImports = await readFile(marker, 'utf8').catch(() => '')
    await expect(page.getByRole('button', { name: '真实运动未开放', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '仅计算离线目标', exact: true })).toBeDisabled()
    await page.getByLabel('设备/工装编号（人工记录）', { exact: true }).fill('OFFLINE-TEST-ONLY')
    await page.getByLabel('记录审核人', { exact: true }).fill('test-fixture-not-an-attestation')
    const now = new Date()
    await page.getByLabel('记录审核日期', { exact: true }).fill(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
    await page.getByRole('button', { name: '记录当前连接配置绑定', exact: true }).click()
    await page.getByText('核验材料引用（不自动认定验收通过）', { exact: true }).click()
    for (const label of ['硬接线急停核验材料', '断线制动核验材料', '行程与机械限位材料', '电机参数映射与标定材料']) {
      await page.getByLabel(label, { exact: true }).fill('TEST REFERENCE ONLY - NOT VERIFIED')
    }
    for (const [label, value] of Object.entries({ '行程下限（mm）': '0', '行程上限（mm）': '100', '单次距离上限（mm）': '5', '单次时长上限（ms）': '1000', '每毫米脉冲数': '100', '零点脉冲': '0', '规划速度上限（r/min）': '10' })) {
      await page.getByLabel(`1 号电机${label}`, { exact: true }).fill(value)
    }
    await page.getByLabel('标定方向', { exact: true }).selectOption('1')
    await page.getByRole('button', { name: '保存安全草稿', exact: true }).click()
    await expect(page.getByText('安全草稿无未保存修改', { exact: true })).toBeVisible()
    const file = join(data, 'config', 'motion-safety.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.machineId).toBe('OFFLINE-TEST-ONLY')
    expect(saved.hardwareVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.motor2.minimumMm).toBeNull()
    expect(saved.canExecute).toBeUndefined()
    await expect(page.getByRole('button', { name: '真实运动未开放', exact: true })).toBeDisabled()
    for (const [label, value] of Object.entries({ '人工起点（mm）': '0', '规划目标（mm）': '1.25', '规划时长（ms）': '100', '规划速度（r/min）': '5' })) {
      await page.getByLabel(label, { exact: true }).fill(value)
    }
    await page.getByRole('button', { name: '仅计算离线目标', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '离线结果（不可执行）' })).toContainText('目标脉冲 125')
    await page.getByLabel('规划目标（mm）', { exact: true }).fill('6')
    await page.getByRole('button', { name: '仅计算离线目标', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '单次距离' })).toBeVisible()
    await page.getByLabel('规划目标（mm）', { exact: true }).fill('1.25')
    await page.getByRole('button', { name: '仅计算离线目标', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '离线结果（不可执行）' })).toBeVisible()
    await page.getByLabel('设备/工装编号（人工记录）', { exact: true }).fill('UNSAVED-SAFETY-DRAFT')
    page.removeListener('dialog', accept)
    page.once('dialog', dialog => { void dialog.dismiss() })
    await page.getByRole('button', { name: '外观与主题', exact: true }).click()
    await expect(page.getByLabel('设备/工装编号（人工记录）', { exact: true })).toHaveValue('UNSAVED-SAFETY-DRAFT')
    await page.getByLabel('设备/工装编号（人工记录）', { exact: true }).fill('OFFLINE-TEST-ONLY')
    await page.getByRole('button', { name: '仅计算离线目标', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '离线结果（不可执行）' })).toBeVisible()
    const changed = await page.evaluate(() => window.labDesktop!.request<any>('hardware.get')).then(value => value.config)
    changed.motors.motor1 = 3
    await page.evaluate(config => window.labDesktop!.request('hardware.save', { config }), changed)
    await expect(page.getByText(/未绑定或保存的连接配置已变化/)).toBeVisible()
    await expect(page.getByRole('button', { name: '仅计算离线目标', exact: true })).toBeDisabled()
    await expect(page.getByRole('status').filter({ hasText: '历史离线结果' })).toBeVisible()
    const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.safety.status'))
    expect(status.bindingMatches).toBe(false)
    expect(Object.values(status.targets).every((value: any) => !value.canExecute)).toBe(true)
    const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('state.get'))
    expect(Object.values(snapshot.state.devices)).toEqual([false, false, false])
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe(startupSerialImports)
    expect(errors).toEqual([])
    await page.getByRole('heading', { name: '运动安全草稿与能力评估', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/cabbage-motion-safety.png', fullPage: true })
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})

test('external safety file edits cannot silently enable execution or be overwritten', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-safety-file-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'safety-tests-only' } })
  try {
    const page = await app.firstWindow()
    await enter(page)
    const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('hardware.safety.get'))
    const file = join(data, 'config', 'motion-safety.json')
    const forged = JSON.stringify({ ...snapshot.config, canExecute: true })
    await writeFile(file, forged)
    await expect(page.getByRole('alert').filter({ hasText: '外部修改' })).toBeVisible()
    const error = await page.evaluate(async snapshot => {
      try {
        await window.labDesktop!.request('hardware.safety.save', { config: snapshot.config, expectedVersion: snapshot.assessment.configVersion, expectedHardwareVersion: snapshot.assessment.hardwareVersion })
        return 'unexpected success'
      } catch (reason) { return (reason as Error).message }
    }, snapshot)
    expect(error).toContain('外部修改')
    expect(await readFile(file, 'utf8')).toBe(forged)
    await page.evaluate(() => window.labDesktop!.request('device.command', { type: 'emergency' }))
    const result = await page.evaluate(() => window.labDesktop!.request<any>('hardware.safety.status'))
    expect(Object.values(result.targets).every((target: any) => !target.canExecute && !target.canPreview)).toBe(true)
    await page.evaluate(() => window.labDesktop!.restartController())
    const restarted = await page.evaluate(() => window.labDesktop!.request<any>('hardware.safety.get'))
    expect(restarted.assessment.error).toContain('读取失败')
    expect(Object.values(restarted.assessment.targets).every((target: any) => !target.canExecute)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(forged)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
