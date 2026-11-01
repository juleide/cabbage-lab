import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import hooks from '../../scripts/controller-package-hooks.cjs'

const archId = { ia32: 0, x64: 1, arm: 2, arm64: 3 }[process.arch]

test('packaging checks native target, executable and onedir runtime before and after resource copy', async () => {
  const root = mkdtempSync(join(tmpdir(), '打包 资源 '))
  try {
    const source = join(root, 'dist/controller/lab-controller')
    const output = join(root, 'installed')
    const destination = process.platform === 'darwin'
      ? join(output, 'Cabbage Lab.app/Contents/Resources/controller')
      : join(output, 'resources/controller')
    const context = { arch: archId, electronPlatformName: process.platform, appOutDir: output,
      packager: { projectDir: root, appInfo: { productFilename: 'Cabbage Lab' } } }
    const exe = process.platform === 'win32' ? 'lab-controller.exe' : 'lab-controller'
    const target = { platform: process.platform, arch: process.arch }
    for (const directory of [source, destination]) {
      mkdirSync(join(directory, '_internal'), { recursive: true })
      writeFileSync(join(directory, 'build-target.json'), JSON.stringify(target))
      writeFileSync(join(directory, exe), 'fixture, not executable')
    }
    await hooks.beforePack(context)
    await hooks.afterPack(context)
    await assert.rejects(hooks.beforePack({ ...context, electronPlatformName: process.platform === 'win32' ? 'darwin' : 'win32' }), /禁止跨平台/)
    await assert.rejects(hooks.beforePack({ ...context, arch: process.arch === 'x64' ? 3 : 1 }), /禁止跨平台/)
    writeFileSync(join(source, 'build-target.json'), JSON.stringify({ ...target, arch: 'universal' }))
    await assert.rejects(hooks.beforePack(context), /禁止跨平台/)
    writeFileSync(join(source, 'build-target.json'), JSON.stringify(target))
    rmSync(join(source, exe))
    await assert.rejects(hooks.beforePack(context), /缺少独立控制端/)
    rmSync(join(destination, '_internal'), { recursive: true })
    await assert.rejects(hooks.afterPack(context), /缺少控制端运行库/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
