import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportRowLimit, readExportRowLimit, writeCsvParts } from '../../src/main/services/csv-export.ts'
import { samplesToCsv } from '../../src/shared/csv.ts'
import { pressureColor } from '../../src/renderer/src/graphics/pressureMap.ts'

test('CSV pages have one BOM/header and preserve units and precision', () => {
  const at = '2026-10-28T01:00:00.000Z'
  const row = { time: at, normal: 10, area: 20, friction: 3, speed: 4, coefficient: 0.3, pressure: 0.35 }
  const contents = samplesToCsv([]) + samplesToCsv([row], false)
  assert.equal(contents.charCodeAt(0), 0xfeff)
  assert.equal(contents.split('\ufeff').length, 2)
  assert.equal(contents.split('\r\n')[1], `${at},10.00,20.00,3.00,4.00,0.300,0.35,13.60,7.40`)
})

test('array color mapping clamps raw samples to default and configured display ranges', () => {
  assert.deepEqual(pressureColor(0), [234, 244, 237])
  assert.deepEqual(pressureColor(4095), [217, 99, 77])
  assert.deepEqual(pressureColor(-1), pressureColor(0))
  assert.deepEqual(pressureColor(65535), pressureColor(4095))
  assert.deepEqual(pressureColor(-100, { minimum: -100, maximum: 100 }), pressureColor(0))
  assert.deepEqual(pressureColor(100, { minimum: -100, maximum: 100 }), pressureColor(4095))
})

test('export threshold supports live configuration and explicit environment overrides', async () => {
  assert.equal(exportRowLimit(undefined), 5000)
  assert.equal(exportRowLimit('500000'), 500000)
  assert.equal(exportRowLimit(' 3 '), 3)
  for (const value of ['', '0', '-1', '1.5', 'abc', 'Infinity', '1e3', '9007199254740992']) {
    assert.throws(() => exportRowLimit(value), /LAB_EXPORT_MAX_ROWS/)
  }
  const directory = await mkdtemp(join(tmpdir(), 'lab-export-config-'))
  try {
    const filename = join(directory, '.env')
    assert.equal(await readExportRowLimit(filename, undefined), 5000)
    await writeFile(filename, 'LAB_EXPORT_MAX_ROWS=5000\n')
    assert.equal(await readExportRowLimit(filename, undefined), 5000)
    await writeFile(filename, 'LAB_EXPORT_MAX_ROWS=7\n')
    assert.equal(await readExportRowLimit(filename, undefined), 7)
    assert.equal(await readExportRowLimit(filename, '9'), 9)
    await writeFile(filename, 'LAB_EXPORT_MAX_ROWS=invalid\n')
    await assert.rejects(readExportRowLimit(filename, undefined), /LAB_EXPORT_MAX_ROWS/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('small paged exports rotate files without duplicate rows, missing rows or extra headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-csv-'))
  const sample = index => ({ time: `sample-${index}`, normal: index, area: 20, friction: 3, speed: 4, coefficient: 0.3, pressure: 0.35 })
  try {
    for (const [count, threshold] of [[2, 3], [3, 3], [4, 3], [6, 3], [7, 3], [503, 251]]) {
      const filenames = []
      const offsets = []
      const all = Array.from({ length: count + 2 }, (_, index) => sample(index))
      const fileCount = await writeCsvParts({
        count, rowsPerFile: threshold, serialize: samplesToCsv,
        readPage: async (offset, limit) => { offsets.push([offset, limit]); return all.slice(offset, offset + limit) },
        openPart: index => {
          const filename = join(directory, `${count}-${threshold}-part${index}.csv`)
          filenames.push(filename)
          return open(filename, 'wx')
        }
      })
      assert.equal(fileCount, Math.ceil(count / threshold))
      const combined = []
      for (let index = 0; index < filenames.length; index++) {
        const text = await readFile(filenames[index], 'utf8')
        assert.equal(text.charCodeAt(0), 0xfeff)
        assert.equal(text.split('\ufeff').length, 2)
        const lines = text.slice(1).trimEnd().split('\r\n')
        assert.equal(lines[0], samplesToCsv([]).slice(1).trimEnd())
        const rows = lines.slice(1)
        assert.equal(rows.length, Math.min(threshold, count - index * threshold))
        combined.push(...rows.map(row => row.split(',')[0]))
      }
      assert.deepEqual(combined, all.slice(0, count).map(row => row.time))
      assert.ok(offsets.every(([offset, limit]) => limit <= 250 && offset + limit <= count))
    }
    let handle
    await assert.rejects(writeCsvParts({
      count: 2, rowsPerFile: 1, serialize: samplesToCsv,
      readPage: async () => [],
      openPart: async () => { handle = await open(join(directory, 'incomplete.csv'), 'wx'); return handle }
    }), /记录不完整/)
    await assert.rejects(handle.stat(), /closed|EBADF/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
