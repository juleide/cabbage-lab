import { readFile, type FileHandle } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import type { Sample } from '../../shared/controller'

export const DEFAULT_EXPORT_MAX_ROWS = 5000
export const EXPORT_PAGE_SIZE = 250

/** Invalid configuration is an export error, never a silently ignored limit. */
export function exportRowLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EXPORT_MAX_ROWS
  const text = value.trim()
  const limit = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('LAB_EXPORT_MAX_ROWS 必须是大于 0 的安全整数，例如 5000 或 500000')
  }
  return limit
}

/** Resolve once per export: process override > configuration file > built-in default. */
export async function readExportRowLimit(filename: string, environment: string | undefined): Promise<number> {
  if (environment !== undefined) return exportRowLimit(environment)
  let text: string
  try { text = await readFile(filename, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return exportRowLimit(undefined)
    throw new Error(`无法读取导出配置文件：${filename}`)
  }
  return exportRowLimit(parseEnv(text).LAB_EXPORT_MAX_ROWS)
}

interface WriteOptions {
  count: number
  rowsPerFile: number
  readPage: (offset: number, limit: number) => Promise<Sample[]>
  openPart: (index: number) => Promise<FileHandle>
  serialize: (rows: readonly Sample[], includeHeader?: boolean) => string
}

/** Bounded memory, one file at a time. Caller owns staging paths and final publication. */
export async function writeCsvParts({ count, rowsPerFile, readPage, openPart, serialize }: WriteOptions): Promise<number> {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('暂无有效试验采样记录')
  if (!Number.isSafeInteger(rowsPerFile) || rowsPerFile <= 0) throw new Error('单个 CSV 记录上限无效')
  let offset = 0
  let fileCount = 0
  while (offset < count) {
    const partCount = Math.min(rowsPerFile, count - offset)
    const file = await openPart(++fileCount)
    try {
      // FileHandle.writeFile writes the complete batch at the current file position.
      // Calls are sequential; do not use a single write() that may be a short write.
      await file.writeFile(serialize([]), 'utf8')
      let written = 0
      while (written < partCount) {
        const limit = Math.min(EXPORT_PAGE_SIZE, partCount - written)
        const rows = await readPage(offset, limit)
        if (!Array.isArray(rows) || rows.length !== limit) throw new Error('试验记录不完整，导出已中止')
        await file.writeFile(serialize(rows, false), 'utf8')
        written += rows.length
        offset += rows.length
      }
      await file.sync()
    } finally {
      await file.close()
    }
  }
  return fileCount
}
