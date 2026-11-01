const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
function validate(directory, platform, arch) {
  const marker = join(directory, 'build-target.json')
  if (!existsSync(marker)) throw new Error('缺少控制端构建标记，请先执行 pnpm controller:build')
  const target = JSON.parse(readFileSync(marker, 'utf8'))
  if (target.platform !== platform || target.arch !== arch || platform !== process.platform || arch !== process.arch) {
    throw new Error('控制端必须在目标平台和架构原生构建，禁止跨平台/跨架构混装')
  }
  const executable = join(directory, platform === 'win32' ? 'lab-controller.exe' : 'lab-controller')
  if (!existsSync(executable) || !statSync(executable).isFile()) throw new Error('安装资源缺少独立控制端')
  const internal = join(directory, '_internal')
  if (!existsSync(internal) || !statSync(internal).isDirectory()) throw new Error('安装资源缺少控制端运行库目录')
}
exports.beforePack = async context => {
  const arch = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[context.arch]
  validate(join(context.packager.projectDir, 'dist/controller/lab-controller'), context.electronPlatformName, arch)
}
exports.afterPack = async context => {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : join(context.appOutDir, 'resources')
  validate(join(resources, 'controller'), context.electronPlatformName, ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[context.arch])
}
