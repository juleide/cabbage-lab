import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Asset regeneration only; ordinary development and packaging use the committed icons.
if (process.platform !== 'darwin') {
  throw new Error('图标重新生成需在 macOS 运行，使用系统 sips；日常构建无需执行此脚本。')
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, 'resources', 'icons')
const master = join(directory, 'app-icon-master.png')
const temporary = mkdtempSync(join(tmpdir(), 'lab-icons-'))

try {
  const images = new Map()
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const output = join(temporary, `${size}.png`)
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), master, '--out', output], { stdio: 'pipe' })
    images.set(size, readFileSync(output))
  }
  writeFileSync(join(directory, 'app.png'), images.get(512))

  // Modern ICNS contains individually sized PNG representations, including Retina variants.
  const representations = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
    ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
  ]
  const chunks = representations.map(([type, size]) => {
    const image = images.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(image.length + 8, 4)
    return Buffer.concat([header, image])
  })
  const icnsHeader = Buffer.alloc(8)
  icnsHeader.write('icns', 0, 'ascii')
  icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  writeFileSync(join(directory, 'app.icns'), Buffer.concat([icnsHeader, ...chunks]))

  // ICO directories can contain PNG payloads (supported by modern Windows).
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const image = images.get(size)
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  writeFileSync(join(directory, 'app.ico'), Buffer.concat([header, ...sizes.map(size => images.get(size))]))
  console.log('已生成 app.png（512px）、app.ico（7 个尺寸）、app.icns（最高 1024px）')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
