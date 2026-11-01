import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDeviceConnection } from './engineering'

test('shared native selects preserve homepage state, hardware baud defaults and selection', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-select-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`],
    env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_PASSWORD: 'select-tests-only' }
  }).catch(async error => { await rm(data, { recursive: true, force: true }); throw error })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText(/设备未就绪|设备异常/, { exact: true })).toBeVisible()
    const library = page.getByRole('combobox', { name: '记录库选择' })
    await expect(library).toHaveClass(/app-select__control/)
    await library.selectOption('cabbage_test_archive')
    await expect(library).toHaveValue('cabbage_test_archive')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '试验与采集', exact: true }).click()
    await expect(page.getByLabel('默认记录库', { exact: true })).toHaveClass(/app-select__control/)
    await openDeviceConnection(page)
    await page.getByLabel('密码', { exact: true }).fill('select-tests-only')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    await expect(page.getByLabel('波特率', { exact: true })).toHaveClass(/app-select__control/)
    await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('波特率', { exact: true }).locator('option')).toHaveText(['请选择', '1200', '2400', '4800', '9600', '19200', '38400', '115200'])
    await page.getByRole('button', { name: '升降装置 · 独立连接', exact: true }).click()
    await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('38400')
    await page.getByRole('button', { name: '步进电机 · 共用总线', exact: true }).click()
    await page.getByLabel('波特率', { exact: true }).selectOption('9600')
    await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('9600')
    await page.getByRole('button', { name: '拉力与位移', exact: true }).click()
    await expect(page.getByLabel('波特率', { exact: true })).toHaveClass(/app-select__control/)
    await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('9600')
    await expect(page.getByLabel('波特率', { exact: true }).locator('option')).toHaveText(['请选择', '1200', '2400', '4800', '9600', '19200', '38400', '115200'])
    await page.getByLabel('波特率', { exact: true }).selectOption('19200')
    await expect(page.getByLabel('波特率', { exact: true })).toHaveValue('19200')
    await page.getByRole('button', { name: '位移采集', exact: true }).click()
    const model = page.getByLabel('模块类型', { exact: true })
    await expect(model).toHaveClass(/app-select__control/)
    await model.selectOption('p')
    await expect(page.getByLabel('通道', { exact: true })).toBeDisabled()
    await model.selectOption('g')
    await expect(page.getByLabel('通道', { exact: true })).toBeEnabled()
    await page.getByLabel('通道', { exact: true }).selectOption('3')
    await expect(page.getByLabel('通道', { exact: true })).toHaveValue('3')
    await model.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('站号', { exact: true })).toBeFocused()
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
