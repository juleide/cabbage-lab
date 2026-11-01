import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const controllerDir = resolve('dist/controller/lab-controller')
export const executable = process.platform === 'win32' ? 'lab-controller.exe' : 'lab-controller'
export function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 失败（${result.status}）`)
}
export function buildController() {
  rmSync(resolve('dist/controller'), { recursive: true, force: true })
  rmSync(resolve('dist/controller-build'), { recursive: true, force: true })
  const candidates = process.env.LAB_PYTHON ? [process.env.LAB_PYTHON] : [
    ...['.venv', 'backend/.venv'].map(dir => resolve(dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')),
    ...(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])].filter(Boolean)
  const python = candidates.find(command => spawnSync(command, ['-c', 'import sys; assert sys.version_info >= (3,10)']).status === 0)
  if (!python) throw new Error('需要 Python 3.10+；请设置 LAB_PYTHON 为构建解释器路径')
  const probe = spawnSync(python, ['-c', 'import PyInstaller, serial; assert PyInstaller.__version__ == "6.16.0"; assert serial.VERSION == "3.5"; import platform, sys; print(sys.platform + "/" + platform.machine())'], { encoding: 'utf8' })
  if (probe.status !== 0) throw new Error(`构建依赖缺失或版本错误。请在构建虚拟环境执行："${python}" -m pip install -r backend/requirements-build.txt`)
  const machine = probe.stdout.trim().split('/').pop().toLowerCase()
  const arch = ({ amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' })[machine]
  if (!probe.stdout.startsWith(`${process.platform}/`) || arch !== process.arch) throw new Error('Python 与 Node 平台/架构不一致，禁止混装')
  run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console', '--name', 'lab-controller', '--paths', 'backend/src', '--collect-submodules', 'serial', '--distpath', 'dist/controller', '--workpath', 'dist/controller-build/work', '--specpath', 'dist/controller-build', 'backend/controller-entry.py'], { ...process.env, PYINSTALLER_CONFIG_DIR: resolve('dist/controller-build/cache') })
  if (!existsSync(resolve(controllerDir, executable))) throw new Error('控制端可执行文件缺失')
  writeFileSync(resolve(controllerDir, 'build-target.json'), JSON.stringify({ platform: process.platform, arch: process.arch }))
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/build-controller.mjs')) buildController()
