import { app, dialog, type BrowserWindow } from 'electron'
import { open, rename, rm, mkdtemp, lstat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { samplesToCsv } from '../../shared/csv'
import type { Sample } from '../../shared/controller'
import type { ExportResult } from '../../shared/desktop-api'
import type { ControllerProcess } from './controller'
import { readExportRowLimit, writeCsvParts } from './csv-export'

async function removeStaging(path: string, reason: unknown): Promise<never> {
  try { await rm(path, { recursive: true, force: true }) }
  catch {
    const message = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`${message}；临时数据未能清理，请检查：${path}`)
  }
  throw reason
}

function exportTimestamp(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** A single trial snapshot; later samples never extend this export. */
export async function exportRecords(controller: ControllerProcess, window: BrowserWindow, runId?: string): Promise<ExportResult> {
  const configuration = app.isPackaged
    ? join(process.resourcesPath, 'config', 'export.env')
    : join(app.getAppPath(), '.env')
  const rowsPerFile = await readExportRowLimit(configuration, process.env.LAB_EXPORT_MAX_ROWS)
  const snapshot = await controller.request<{ runId: string; count: number }>('records.snapshot', { runId })
  if (!/^[\w-]{1,100}$/.test(snapshot.runId) || !Number.isSafeInteger(snapshot.count) || snapshot.count <= 0) {
    throw new Error('导出快照无效')
  }
  const fileCount = Math.ceil(snapshot.count / rowsPerFile)
  const canceled: ExportResult = { saved: false, count: 0, fileCount: 0 }
  const readPage = (offset: number, limit: number) => controller.request<Sample[]>('records.read', { runId: snapshot.runId, offset, limit })

  if (fileCount === 1) {
    const result = await dialog.showSaveDialog(window, {
      title: '导出试验数据', defaultPath: snapshot.runId + '.csv',
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return canceled
    const outputPath = result.filePath
    const temp = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`)
    // Reserve the staging file before entering cleanup scope so pre-existing files are never removed.
    const file = await open(temp, 'wx')
    try {
      await writeCsvParts({ count: snapshot.count, rowsPerFile, readPage, openPart: async () => file, serialize: samplesToCsv })
      await rename(temp, outputPath)
      return { saved: true, count: snapshot.count, fileCount: 1, outputPath, outputKind: 'file' }
    } catch (reason) { return removeStaging(temp, reason) }
  }

  const confirmation = await dialog.showMessageBox(window, {
    type: 'info', title: '分文件导出',
    message: `本次试验共 ${snapshot.count.toLocaleString()} 条记录，将导出为 ${fileCount.toLocaleString()} 个 CSV。`,
    detail: `每个 CSV 最多 ${rowsPerFile.toLocaleString()} 条记录。请选择保存位置，程序将创建独立文件夹，不覆盖已有导出结果。`,
    buttons: ['选择保存目录', '取消'], defaultId: 0, cancelId: 1
  })
  if (confirmation.response !== 0) return canceled
  const selected = await dialog.showOpenDialog(window, {
    title: '选择分文件导出保存位置', buttonLabel: '保存到此目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (selected.canceled || !selected.filePaths[0]) return canceled
  const parent = selected.filePaths[0]
  const outputPath = join(parent, `${snapshot.runId}-export-${exportTimestamp()}-${randomUUID()}`)
  const staging = await mkdtemp(join(parent, `.${snapshot.runId}-export-tmp-`))
  const digits = Math.max(3, String(fileCount).length)
  try {
    await writeCsvParts({
      count: snapshot.count, rowsPerFile, readPage, serialize: samplesToCsv,
      openPart: index => open(join(staging, `${snapshot.runId}-part${String(index).padStart(digits, '0')}.csv`), 'wx')
    })
    // The UUID makes collisions unlikely; explicitly refuse an existing destination as well.
    const existing = await lstat(outputPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (existing) throw new Error('目标导出目录已存在，请重新选择保存位置')
    await rename(staging, outputPath)
    return { saved: true, count: snapshot.count, fileCount, outputPath, outputKind: 'directory' }
  } catch (reason) { return removeStaging(staging, reason) }
}
