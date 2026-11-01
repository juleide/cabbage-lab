import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyControllerDirectory } from '../../scripts/copy-controller.mjs'

test('controller copy preserves nested binary files, empty files/directories and executable permissions in Unicode paths', () => {
  const root = mkdtempSync(join(tmpdir(), '控制端 复制测试 '))
  try {
    const source = join(root, '源 文件')
    const destination = join(root, '安装 资源', 'controller')
    mkdirSync(join(source, '_internal', '空 目录'), { recursive: true })
    const bytes = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 256))
    writeFileSync(join(source, '_internal', '运行库.dll'), bytes)
    writeFileSync(join(source, 'lab-controller'), 'executable fixture')
    chmodSync(join(source, 'lab-controller'), 0o755)
    writeFileSync(join(source, '_internal', 'empty'), '')
    copyControllerDirectory(source, destination)
    assert.deepEqual(readFileSync(join(destination, '_internal', '运行库.dll')), bytes)
    assert.equal(readFileSync(join(destination, 'lab-controller'), 'utf8'), 'executable fixture')
    assert.equal(statSync(join(destination, '_internal', 'empty')).size, 0)
    assert.ok(statSync(join(destination, '_internal', '空 目录')).isDirectory())
    if (process.platform !== 'win32') assert.equal(statSync(join(destination, 'lab-controller')).mode & 0o777, 0o755)
    assert.throws(() => copyControllerDirectory(join(root, 'missing'), join(root, 'invalid')), /ENOENT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('controller copy preserves relative file/directory symlinks after original bundle is removed', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-links-'))
  try {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    mkdirSync(join(source, '_internal'), { recursive: true })
    writeFileSync(join(source, '_internal', 'library'), 'library fixture')
    symlinkSync('_internal/library', join(source, 'file-link'))
    symlinkSync('_internal', join(source, 'dir-link'))
    copyControllerDirectory(source, destination)
    rmSync(source, { recursive: true })
    assert.equal(readlinkSync(join(destination, 'file-link')), '_internal/library')
    assert.equal(readlinkSync(join(destination, 'dir-link')), '_internal')
    assert.equal(readFileSync(join(destination, 'file-link'), 'utf8'), 'library fixture')
    assert.equal(readFileSync(join(destination, 'dir-link', 'library'), 'utf8'), 'library fixture')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
