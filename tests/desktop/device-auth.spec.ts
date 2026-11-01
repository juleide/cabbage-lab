import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDeviceConnection } from './engineering'

const password = 'engineering-desktop-tests-only'

test('ten version taps open password-only engineering mode; categories retain access and leaving settings locks it', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-engineering-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: '', LAB_DEVICE_DEBUG_PASSWORD: password } })
  try {
    const page = await app.firstWindow()
    const menu = page.getByRole('button', { name: '设备连接', exact: true })
    const dialog = page.getByRole('dialog', { name: '工程模式', exact: true })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await page.getByRole('button', { name: '运行与诊断', exact: true }).click()
    for (let i = 0; i < 9; i++) await page.getByRole('button', { name: '应用版本', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: '应用版本', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    for (let i = 0; i < 9; i++) await page.getByRole('button', { name: '应用版本', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: '外观与主题', exact: true }).click()
    await openDeviceConnection(page)
    await page.getByLabel('密码', { exact: true }).fill('wrong')
    await dialog.getByRole('button', { name: '进入', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('密码错误')
    await expect(menu).toHaveCount(0)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await dialog.getByRole('button', { name: '进入', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(menu).toBeVisible()
    await expect(page.getByRole('heading', { name: '设备连接', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '外观与主题', exact: true }).click()
    await expect(menu).toBeVisible()
    expect(await page.evaluate(() => window.labDesktop!.getDeviceDebugAuth())).toMatchObject({ authorized: true })
    await menu.click()
    await page.getByRole('button', { name: '返回试验台', exact: true }).click()
    expect(await page.evaluate(() => window.labDesktop!.getDeviceDebugAuth())).toMatchObject({ authorized: false })
    const denied = await page.evaluate(async () => {
      try { await window.labDesktop!.request('hardware.get'); return '' }
      catch (error) { return (error as Error).message }
    })
    expect(denied).toContain('未解锁或已过期')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await openDeviceConnection(page)
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.labDesktop!.loginDeviceDebug('wrong'))
    await expect(dialog.getByRole('status')).toContainText('秒后重试')
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await openDeviceConnection(page)
    await expect(dialog.getByRole('status')).toContainText('秒后重试')
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})

test('missing engineering password fails closed', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-engineering-missing-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_PASSWORD: '' } })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await openDeviceConnection(page)
    const dialog = page.getByRole('dialog', { name: '工程模式', exact: true })
    await expect(dialog.getByRole('status')).toContainText('未配置工程模式密码')
    await expect(dialog.getByRole('button', { name: '进入', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '设备连接', exact: true })).toHaveCount(0)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
