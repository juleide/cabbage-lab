import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Python-backed desktop and settings', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-desktop-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, LAB_DATA_DIR: data } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText('设备已就绪', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
    await page.getByRole('switch', { name: '1 号电机启停' }).click()
    await page.getByRole('switch', { name: '2 号电机启停' }).click()
    await page.getByRole('button', { name: '联动开始', exact: true }).click()
    await expect(page.getByText('联动试验中', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '紧急停止', exact: true }).click()
    await expect(page.getByText('设备已急停', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByRole('heading', { name: '外观与主题' })).toBeVisible()
    await page.getByRole('button', { name: '运行与诊断', exact: true }).click()
    await expect(page.getByText('Python 在线', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
