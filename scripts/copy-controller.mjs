import { lstatSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync, readlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Avoid fs.cpSync/copyFileSync's native fast-copy path: it has crashed with
 * 0xC0000005 on the target Windows machine. Copy bytes through ordinary I/O.
 * Preserve relative links so macOS onedir bundles remain relocatable. */
export function copyControllerDirectory(source, destination) {
  const entry = lstatSync(source)
  if (entry.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination, statSync(source).isDirectory() ? 'dir' : 'file')
  } else if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) {
      copyControllerDirectory(join(source, name), join(destination, name))
    }
  } else if (entry.isFile()) {
    // At most one file is held in memory; preserve executable permissions on Unix.
    writeFileSync(destination, readFileSync(source), { mode: entry.mode & 0o777 })
  } else {
    throw new Error(`不支持的控制端资源类型：${source}`)
  }
}
