import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('real-only startup keeps the original homepage and eight zero metrics without hardware', async ({}, info) => {
  const data = await mkdtemp(join(tmpdir(), 'lab-real-startup-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: {
    ...process.env, LAB_DATA_DIR: data
  } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByText('设备未就绪', { exact: true })).toBeVisible()
    await expect(page.locator('.metric')).toHaveCount(8)
    await expect(page.getByText('等待真实读数', { exact: true })).toBeVisible()
    await expect(page.getByRole('switch')).toHaveCount(3)
    await expect(page.locator('#pressure')).toHaveCount(1)
    for (const name of ['初始化', '轴回零', '传感器置零', '联动开始']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /切换真实电机模式|切回模拟模式|连接主面板真实电机|验证研发权限/ })).toHaveCount(0)
    for (const value of await page.locator('.metric-value > span').allTextContents()) {
      expect(Number(value)).toBe(0)
    }
    await page.getByLabel('记录库选择').selectOption('cabbage_test_archive')
    await expect.poll(async () => page.evaluate(async () =>
      (await window.labDesktop!.request<any>('state.get')).state.database
    )).toBe('cabbage_test_archive')
    await page.waitForTimeout(1200)
    const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('state.get'))
    expect(Object.values(snapshot.state.values).every(value => value === 0)).toBe(true)
    expect(Object.values(snapshot.state.measurementQuality).every((value: any) => !value.valid)).toBe(true)
    expect(snapshot.pressureFrame).toBeNull()
    expect(snapshot.state.readiness.state).toBe('unavailable')
    expect(snapshot.state.readiness.missing).toContain('arrayPress')
    expect(snapshot.state.readiness.devices.lift.required).toBe(true)
    const initialGrid = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')!
      const first = Array.from(context.getImageData(2, 2, 1, 1).data)
      const last = Array.from(context.getImageData(632, 632, 1, 1).data)
      return { first, last }
    })
    expect(initialGrid.first[3]).toBe(255)
    expect(initialGrid.first).toEqual(initialGrid.last)
    expect(await page.evaluate(() => window.labDesktop!.request<any[]>('records.list'))).toEqual([])
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath('real-startup.png'), fullPage: true })
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
