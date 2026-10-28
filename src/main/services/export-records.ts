import { dialog, type BrowserWindow } from 'electron'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { samplesToCsv } from '../../shared/csv'
import type { Sample } from '../../shared/controller'
import type { ControllerProcess } from './controller'

/** Snapshot count first; page through SQLite without shipping the whole trial to React. */
export async function exportRecords(controller: ControllerProcess, window: BrowserWindow, runId?: string) {
  const snapshot = await controller.request<{ runId: string; count: number }>('records.snapshot', { runId })
  const result = await dialog.showSaveDialog(window, {
    title: '导出试验数据', defaultPath: snapshot.runId + '.csv',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false, count: 0 }
  const temp = join(dirname(result.filePath), `.${basename(result.filePath)}.${randomUUID()}.tmp`)
  const file = await open(temp, 'wx')
  try {
    await file.write(samplesToCsv([]))
    for (let offset = 0; offset < snapshot.count;) {
      const limit = Math.min(250, snapshot.count - offset)
      const rows = await controller.request<Sample[]>('records.read', { runId: snapshot.runId, offset, limit })
      if (rows.length !== limit) throw new Error('试验记录不完整，导出已中止')
      await file.write(samplesToCsv(rows, false))
      offset += rows.length
    }
    await file.sync()
    await file.close()
    await rename(temp, result.filePath)
    return { saved: true, count: snapshot.count }
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}
