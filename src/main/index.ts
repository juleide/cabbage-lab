import { app, BrowserWindow, ipcMain, shell, powerMonitor, powerSaveBlocker, nativeImage } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererMethods } from '../shared/controller'
import type { ControllerEvent, Snapshot } from '../shared/controller'
import { ControllerProcess } from './services/controller'
import { exportRecords } from './services/export-records'
import { UIPreferences } from './services/preferences'
import { loadDeviceDebugAuth, type DeviceDebugAuth } from './services/device-auth'

const here = fileURLToPath(new URL('.', import.meta.url))
let mainWindow: BrowserWindow | null = null
let controller: ControllerProcess
let quitting = false
let restarting = false
let exporting = false
let sleepBlocker: number | undefined
let root = ''
let preferences: UIPreferences
let deviceAuth: DeviceDebugAuth
let authWasAuthorized = false
let authTimer: ReturnType<typeof setInterval> | undefined

function power(active: boolean) {
  if (active && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!active && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined }
}

function handler(channel: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('无效的调用来源')
    return callback(...args)
  })
}

function lockDeviceDebug() {
  authWasAuthorized = false
  deviceAuth.lock()
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('device-auth:locked')
}

function registerIPC() {
  handler('device-auth:status', () => deviceAuth.status(mainWindow!.webContents.id))
  handler('device-auth:login', (username: unknown, password: unknown) => {
    const result = deviceAuth.login(mainWindow!.webContents.id, username, password)
    authWasAuthorized = result.authorized
    if (!result.authorized) mainWindow!.webContents.send('device-auth:locked')
    return result
  })
  handler('device-auth:lock', () => lockDeviceDebug())
  handler('device-auth:touch', () => deviceAuth.touch(mainWindow!.webContents.id))
  handler('controller:request', (method: unknown, params: unknown = {}) => {
    if (typeof method !== 'string' || !rendererMethods.includes(method)) throw new Error('不允许的控制方法')
    if (!params || typeof params !== 'object' || Array.isArray(params) || Buffer.byteLength(JSON.stringify(params)) > 64 * 1024) throw new Error('请求参数无效')
    if (method.startsWith('hardware.')) {
      deviceAuth.require(mainWindow!.webContents.id)
      deviceAuth.touch(mainWindow!.webContents.id)
    }
    return controller.request(method, params as Record<string, unknown>)
  })
  handler('controller:restart', async () => {
    if (restarting || exporting) throw new Error('正在执行其他操作，请稍后重试')
    restarting = true
    try {
      if (controller.online) {
        const { state } = await controller.request<Snapshot>('state.get')
        if (state.running || Object.values(state.devices).some(Boolean)) throw new Error('请先停止试验和全部执行机构')
      }
      await controller.stop()
      await controller.start()
    } finally { restarting = false }
  })
  handler('app:info', () => ({
    version: app.getVersion(), platform: process.platform, simulation: true,
    dataDir: join(root, 'data'), configDir: join(root, 'config'), logsDir: join(root, 'logs'), python: controller.python
  }))
  handler('app:directory', async (kind: unknown) => {
    if (kind !== 'data' && kind !== 'config' && kind !== 'logs') throw new Error('无效的目录')
    const error = await shell.openPath(join(root, kind))
    if (error) throw new Error(error)
  })
  handler('records:export', async (runId: unknown) => {
    if (runId !== undefined && (typeof runId !== 'string' || !/^[\w-]{1,100}$/.test(runId))) throw new Error('无效的试验编号')
    if (exporting || restarting) throw new Error('正在执行其他操作，请稍后重试')
    exporting = true
    try { return await exportRecords(controller, mainWindow!, runId as string | undefined) }
    finally { exporting = false }
  })
  handler('ui:theme:get', () => preferences.theme)
  handler('ui:theme:set', (value: unknown) => preferences.setTheme(value))
  handler('ui:range:get', () => preferences.displayRange)
  handler('ui:range:set', (value: unknown) => preferences.setDisplayRange(value))
}

function createWindow() {
  const icons = app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(app.getAppPath(), 'resources', 'icons')
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(nativeImage.createFromPath(join(icons, 'app.png')))
  }
  mainWindow = new BrowserWindow({
    width: 1024, height: 600, minWidth: 768, minHeight: 450,
    icon: join(icons, process.platform === 'win32' ? 'app.ico' : 'app.png'),
    title: '甘蓝检测多功能试验台',
    backgroundColor: { light: '#f3f5f4', dark: '#14191b', blue: '#eaf3ff' }[preferences.theme],
    autoHideMenuBar: true,
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  mainWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) lockDeviceDebug()
  })
  mainWindow.webContents.on('render-process-gone', () => lockDeviceDebug())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12' || input.isAutoRepeat) return
    event.preventDefault()
    mainWindow?.webContents.openDevTools({ mode: 'detach' })
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(here, '../renderer/index.html'))
  mainWindow.on('closed', () => { deviceAuth.lock(); clearInterval(authTimer); mainWindow = null })
  authTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && authWasAuthorized && !deviceAuth.status(mainWindow.webContents.id).authorized) {
      authWasAuthorized = false
      mainWindow.webContents.send('device-auth:locked')
    }
  }, 1000)
  authTimer.unref()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { mainWindow?.restore(); mainWindow?.focus() })
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.labcontrol.desktop')
    // Simulation data never shares the reference project's directories or real hardware data.
    root = resolve(process.env.LAB_DATA_DIR || join(app.getPath('userData'), 'simulation'))
    for (const kind of ['data', 'config', 'logs']) await mkdir(join(root, kind), { recursive: true })
    const bundledEnv = app.isPackaged ? join(process.resourcesPath, 'config', 'device.env.enc') : undefined
    deviceAuth = await loadDeviceDebugAuth(
      app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
      app.isPackaged ? {} : process.env,
      bundledEnv
    )
    delete process.env.LAB_DEVICE_DEBUG_USERNAME
    delete process.env.LAB_DEVICE_DEBUG_PASSWORD
    preferences = new UIPreferences(join(app.getPath('userData'), 'ui.json'))
    await preferences.load()
    controller = new ControllerProcess(root)
    controller.on('event', (event: ControllerEvent) => {
      if (event.event === 'state' || event.event === 'ready') {
        const state = event.event === 'ready' ? event.data.state : event.data
        power(state.running || Object.values(state.devices).some(Boolean))
      } else if (event.event === 'offline') power(false)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('controller:event', event)
    })
    registerIPC()
    createWindow()
    powerMonitor.on('suspend', () => {
      lockDeviceDebug()
      void controller.request('system.suspend').catch(() => controller.stop()).catch(() => {})
    })
    void controller.start().catch(() => { /* The settings page exposes errors and manual restart. */ })
  }).catch(error => { console.error(error); app.quit() })
  app.on('before-quit', event => {
    if (quitting || !controller) return
    event.preventDefault()
    quitting = true
    void Promise.allSettled([controller.stop(), preferences.flush()]).finally(() => { power(false); app.quit() })
  })
  app.on('window-all-closed', () => app.quit())
}
