import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('stop-only motion diagnostics keep hardware outcome distinct from simulation', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-motion-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'motion-tests-only' } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => { void dialog.accept() })
    await expect(page.getByText('设备已就绪', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
    await page.getByLabel('密码', { exact: true }).fill('motion-tests-only')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis as any
      fixture.__motionStale = false
      const statuses: Record<string, any> = {}
      fixture.__motionCalls = []
      ipcMain.removeHandler('controller:request')
      ipcMain.handle('controller:request', (_event, method, params) => {
        if (method === 'hardware.sensors.status') return {}
        if (method === 'hardware.status') return { state: 'idle', message: '', readings: null }
        if (method.startsWith('hardware.motion.')) {
          fixture.__motionCalls.push({ method, params })
          const section = params.section
          if (method === 'hardware.motion.connect') statuses[section] = {
            sessionId: `fixture-${section}`, section, source: 'hardware', state: 'monitoring',
            configVersion: 'fixture-version', faultLatched: false, error: null, motionAllowed: false,
            readings: section === 'motors' ? { motor1: { raw: 16, running: false, enabled: true, fault: false, quality: 'valid' } } : {}, commands: {}
          }
          if (method === 'hardware.motion.stop') {
            statuses[section].commands = { [section === 'motors' ? 'motor1' : 'lift']: {
              id: 'fixture-stop', emergency: params.emergency, state: section === 'motors' ? 'unknown' : 'sent',
              error: section === 'motors' ? '停止应答超时' : null, motionConfirmed: false
            } }
            statuses[section].faultLatched = params.emergency
          }
          if (method === 'hardware.motion.disconnect') statuses[section].state = 'disconnected'
          if (fixture.__motionStale && statuses.motors) statuses.motors.readings.motor1.quality = 'stale'
          return statuses
        }
        throw new Error(`Unexpected fixture request ${method}`)
      })
    })
    const motors = page.getByRole('article', { name: '电机总线真实诊断', exact: true })
    const lift = page.getByRole('article', { name: '升降装置真实诊断', exact: true })
    await motors.getByRole('button', { name: '连接电机总线诊断', exact: true }).click()
    await expect(motors.getByText('诊断监听中', { exact: true })).toBeVisible()
    await expect(motors.getByText(/运行位为 0（非安全停机确认）/)).toBeVisible()
    await expect(page.getByLabel('共用串口', { exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '连接验证', exact: true })).toBeDisabled()
    await motors.getByRole('button', { name: '发送电机软件急停', exact: true }).click()
    await expect(motors.getByRole('status')).toContainText('停止结果未知，请现场确认')
    await expect(motors.getByText(/故障\/软件急停已锁存/)).toBeVisible()
    await app.evaluate(() => { (globalThis as any).__motionStale = true })
    await expect(motors.getByText('motor1：反馈已过期或不可用', { exact: true })).toBeVisible()
    await lift.getByRole('button', { name: '连接升降装置诊断', exact: true }).click()
    await expect(lift.getByText(/未收到有效反馈/)).toBeVisible()
    await lift.getByRole('button', { name: '发送升降装置停止', exact: true }).click()
    await expect(lift.getByRole('status')).toContainText('无 ACK，机械停止未确认')
    await motors.getByRole('button', { name: '停止并断开电机总线', exact: true }).click()
    await lift.getByRole('button', { name: '停止并断开升降装置', exact: true }).click()
    await expect(page.getByLabel('共用串口', { exact: true })).toBeEnabled()
    const calls = await app.evaluate(() => (globalThis as any).__motionCalls as { method: string; params: any }[])
    expect(calls.find(call => call.method === 'hardware.motion.stop')?.params).toEqual({ section: 'motors', emergency: true })
    expect(calls.every(call => ['hardware.motion.status', 'hardware.motion.connect', 'hardware.motion.stop', 'hardware.motion.disconnect'].includes(call.method))).toBe(true)
    expect(errors).toEqual([])
    await page.getByRole('heading', { name: '真实执行机构状态与停止诊断', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/cabbage-motion-diagnostics.png', fullPage: true })
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})

test('real IPC and debug lock stop both fake motor stations before closing their port', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-motion-ipc-'))
  const journal = join(data, 'serial-events.jsonl')
  await writeFile(join(data, 'serial.py'), `
import json, os, time
from lab_controller.devices.modbus import frame
def record(kind, **data):
    with open(os.environ['LAB_MOTION_TEST_WRITES'], 'a') as output:
        output.write(json.dumps(dict(kind=kind, **data)) + '\\n')
class Serial:
    def __init__(self, **kwargs): self.buffer = bytearray()
    def open(self): record('open')
    def close(self): record('close')
    def reset_input_buffer(self): self.buffer.clear()
    def write(self, data):
        record('write', hex=data.hex())
        if data[1] == 3: self.buffer.extend(frame(bytes([data[0], 3, 2, 0, 16])))
        if data[1] == 6: self.buffer.extend(data)
        return len(data)
    def read(self, size):
        time.sleep(0.005)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result
`)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, PYTHONPATH: data, LAB_MOTION_TEST_WRITES: journal, LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'motion-ipc-tests-only' } })
  try {
    const page = await app.firstWindow()
    page.on('dialog', dialog => { void dialog.accept() })
    await expect(page.getByText('设备已就绪', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    async function login() {
      await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
      await page.getByLabel('密码', { exact: true }).fill('motion-ipc-tests-only')
      await page.getByRole('button', { name: '进入', exact: true }).click()
    }
    await login()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    await page.getByLabel('共用串口', { exact: true }).fill('OFFLINE-FAKE-MOTORS')
    await page.getByLabel('波特率', { exact: true }).fill('9600')
    await page.getByLabel('1 号电机站号', { exact: true }).fill('1')
    await page.getByLabel('2 号电机站号', { exact: true }).fill('2')
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible()
    const panel = page.getByRole('article', { name: '电机总线真实诊断', exact: true })
    await panel.getByRole('button', { name: '连接电机总线诊断', exact: true }).click()
    await expect(panel.getByText(/motor2：状态字 16/)).toBeVisible()
    const readJournal = async () => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; hex?: string })
    expect((await readJournal()).filter(event => event.kind === 'write').every(event => event.hex!.slice(2, 4) === '03')).toBe(true)
    await page.getByRole('button', { name: '外观与主题', exact: true }).click()
    await expect.poll(async () => (await readJournal()).at(-1)?.kind).toBe('close')
    const events = await readJournal()
    const stops = events.filter(event => event.kind === 'write' && event.hex!.slice(2, 4) === '06')
    expect(stops.map(event => event.hex!.slice(0, 12)).sort()).toEqual(['0106004e0040', '0206004e0040'])
    expect(events.filter(event => event.kind === 'open')).toHaveLength(1)
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await expect(page.getByRole('heading', { name: '设备调试', exact: true })).toBeVisible()
    await login()
    const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motion.status'))
    expect(status.motors.state).toBe('disconnected')
    expect(status.motors.faultLatched).toBe(true)
    expect(Object.values(status.motors.commands).every((command: any) => command.state === 'acknowledged' && !command.motionConfirmed)).toBe(true)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
