import { expect, type Page } from '@playwright/test'

/** Open the protected entry without assuming that the sidebar is unlocked. */
export async function openDeviceConnection(page: Page) {
  const menu = page.getByRole('button', { name: '设备连接', exact: true })
  if (await menu.isVisible()) { await menu.click(); return }
  await page.getByRole('button', { name: '运行与诊断', exact: true }).click()
  for (let index = 0; index < 10; index++) await page.getByRole('button', { name: '应用版本', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '工程模式', exact: true })).toBeVisible()
}
