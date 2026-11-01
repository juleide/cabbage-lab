import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('real motor controls use Python fake serial feedback, stop independently and lock safely', async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-jog-ui-'))
  const journal = join(data, 'writes.jsonl')
  const signal = join(data, 'fake-control.json')
  async function setFlags(value: Record<string, boolean>) {
    await writeFile(signal + '.tmp', JSON.stringify(value))
    await rename(signal + '.tmp', signal)
  }
  await setFlags({})
  await mkdir(join(data, 'config'))
  const hardware = JSON.parse(await readFile('docs/examples/hardware.v2.example.json', 'utf8'))
  hardware.motors.serial = { port: 'FAKE-JOG', baud: 115200, bits: 8, parity: 'N', stop: 1, timeoutMs: 1000, intervalMs: 30 }
  hardware.motors.motor1 = 1; hardware.motors.motor2 = 2
  for (const [target, direction] of [['motor1', 1], ['motor2', -1]] as const) {
    hardware.motors.operation[target] = { direction, speedRpm: 50, maxSpeedRpm: 100, accelerationMs: 100, decelerationMs: 100, maxRunMs: 60000 }
  }
  await writeFile(join(data, 'config', 'hardware.json'), JSON.stringify(hardware))
  await writeFile(join(data, 'serial.py'), `
import os, json, struct, time
from lab_controller.devices.modbus import frame
class Serial:
    def __init__(self, **kwargs):
        self.buffer = bytearray()
        self.speed = {1: 0, 2: 0}
        self.parameters = {}
    def open(self):
        assert self.port == 'FAKE-JOG', 'Test must not open hardware'
    def close(self): pass
    def reset_input_buffer(self): self.buffer.clear()
    def write(self, packet):
        station, function, address, value = struct.unpack('>BBHH', packet[:-2])
        with open(os.environ['LAB_JOG_SIGNAL']) as stream:
            flags = json.load(stream)
        with open(os.environ['LAB_JOG_JOURNAL'], 'a') as stream:
            stream.write(json.dumps([station, function, address, value]) + '\\n')
        if function == 3:
            assert address in (4, 10)
            if address == 10 and flags.get('dropSpeed'): return len(packet)
            word = (16 | (4 if self.speed[station] else 0)) if address == 4 else self.speed[station] & 65535
            self.buffer.extend(frame(bytes([station, 3, 2]) + struct.pack('>H', word)))
        else:
            assert function == 6 and address in (0x30, 0x31, 0x32, 0x4e)
            if address == 0x31 and flags.get('blockSetup'): return len(packet)
            self.parameters[station, address] = value
            if address == 0x4e:
                assert value in (8, 0x20, 0x40)
                raw = self.parameters.get((station, 0x30), 0)
                self.speed[station] = (raw - 65536 if raw >= 32768 else raw) if value == 8 else 0
                if value == 0x20 and station == 1 and flags.get('dropStopAck'): return len(packet)
            self.buffer.extend(packet)
        return len(packet)
    def read(self, size):
        result = bytes(self.buffer[:size]); del self.buffer[:size]
        if not result: time.sleep(.001)
        return result
`)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: {
    ...process.env, LAB_DATA_DIR: data, PYTHONPATH: data, LAB_JOG_JOURNAL: journal, LAB_JOG_SIGNAL: signal,
    LAB_DEVICE_DEBUG_USERNAME: 'test-engineer', LAB_DEVICE_DEBUG_PASSWORD: 'jog-ui-tests-only'
  } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => { void dialog.accept().catch(() => {}) })
    await expect(page.getByText('设备未就绪', { exact: true })).toBeVisible()
    const denied = await page.evaluate(async () => {
      try { await window.labDesktop!.request('hardware.motor.connect'); return '' }
      catch (error) { return String(error) }
    })
    expect(denied).toMatch(/未解锁/)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '设备连接', exact: true }).click()
    await page.getByLabel('用户名', { exact: true }).fill('test-engineer')
    await page.getByLabel('密码', { exact: true }).fill('jog-ui-tests-only')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    const panel = page.getByRole('region', { name: '真实电机启停', exact: true })
    const motor1 = panel.getByRole('article', { name: '1 号电机真实控制', exact: true })
    const motor2 = panel.getByRole('article', { name: '2 号电机真实控制', exact: true })
    await panel.getByRole('button', { name: '连接真实电机控制', exact: true }).click()
    await expect(motor1.getByRole('button', { name: '启动 1 号电机', exact: true })).toBeEnabled()
    let packets = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(packets.every(packet => packet[1] === 3)).toBe(true)
    await motor1.getByRole('button', { name: '启动 1 号电机', exact: true }).click()
    await expect(motor1.getByText('驱动反馈运行', { exact: true })).toBeVisible()
    await motor2.getByRole('button', { name: '启动 2 号电机', exact: true }).click()
    await expect(motor2.getByText('驱动反馈运行', { exact: true })).toBeVisible()
    await expect(page.getByLabel('共用串口', { exact: true })).toBeDisabled()
    await motor1.getByRole('button', { name: '停止 1 号电机', exact: true }).click()
    await expect(motor1.getByText('驱动反馈停止；机械安全停止未确认', { exact: true })).toBeVisible()
    await expect(motor2.getByText('驱动反馈运行', { exact: true })).toBeVisible()
    await page.screenshot({ path: '/tmp/cabbage-real-motor-controls.png', fullPage: true })
    await page.evaluate(() => window.labDesktop!.lockDeviceDebug())
    const lockedStart = await page.evaluate(async () => {
      try { await window.labDesktop!.request('hardware.motor.start', { target: 'motor1', sessionId: 'old', configVersion: 'old' }); return '' }
      catch (error) { return String(error) }
    })
    expect(lockedStart).toMatch(/未解锁/)
    const lockedStop = await page.evaluate(async () => {
      try { await window.labDesktop!.request('hardware.motor.stop', { target: null, emergency: true }); return '' }
      catch (error) { return String(error) }
    })
    expect(lockedStop).not.toMatch(/未解锁|过期/)
    await expect.poll(async () => {
      const lines = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      return lines.filter(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 0x40).map(packet => packet[0])
    }).toEqual(expect.arrayContaining([1, 2]))
    packets = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(packets.filter(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 8)).toHaveLength(2)
    expect(packets).toContainEqual([2, 6, 0x30, 65486])
    await page.getByRole('button', { name: '返回试验台', exact: true }).click()
    await expect(page.getByText('真实硬件控制', { exact: true })).toBeVisible()
    await page.getByLabel('研发用户名', { exact: true }).fill('test-engineer')
    await page.getByLabel('研发密码', { exact: true }).fill('jog-ui-tests-only')
    await page.getByRole('button', { name: '验证主面板权限', exact: true }).click()
    await expect(page.getByRole('button', { name: '验证主面板权限', exact: true })).toHaveCount(0)
    await expect(page.getByText('真实硬件控制', { exact: true })).toBeVisible()
    for (const name of ['初始化（未接入）', '轴回零（未接入）', '传感器置零（未接入）', '联动采集未接入']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    }
    await expect(page.getByRole('switch', { name: '升降装置启停', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '连接主面板真实电机', exact: true }).click()
    const mainMotor = page.getByRole('switch', { name: '1 号电机启停', exact: true })
    await expect(mainMotor).toBeEnabled()
    await expect(page.locator('.device').filter({ has: mainMotor }).getByText('待机 · 0 r/min', { exact: true })).toBeVisible()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    await page.screenshot({ path: '/tmp/cabbage-main-real-motors.png', fullPage: true })
    const records = await page.evaluate(() => window.labDesktop!.request<any[]>('records.list'))
    expect(records).toEqual([])
    expect(await page.evaluate(async () => Object.hasOwn((await window.labDesktop!.request<any>('state.get')).state, 'motorMode'))).toBe(false)
    await page.getByRole('button', { name: '连接主面板真实电机', exact: true }).click()
    await expect(mainMotor).toBeEnabled()
    await setFlags({ blockSetup: true })
    const beforeSetup = (await readFile(journal, 'utf8')).trim().split('\n').length
    await mainMotor.click()
    await expect.poll(async () => {
      const lines = (await readFile(journal, 'utf8')).trim().split('\n').slice(beforeSetup).map(line => JSON.parse(line))
      return lines.some(packet => packet[1] === 6 && packet[2] === 0x31)
    }, { intervals: [10, 20, 30] }).toBe(true)
    const stop1 = page.getByRole('button', { name: '停止1 号电机', exact: true })
    await expect(stop1).toBeEnabled()
    await stop1.click()
    await expect.poll(async () => {
      const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
      return status.axes.motor1.driverStopped
    }).toBe(true)
    packets = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(packets.filter(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 8)).toHaveLength(3)
    await setFlags({})
    await expect(mainMotor).toBeEnabled()
    await expect(page.locator('.device').filter({ has: mainMotor }).getByText('待机 · 0 r/min', { exact: true })).toBeVisible()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    await setFlags({ dropSpeed: true })
    await expect.poll(async () => {
      const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
      return status.state
    }).toBe('failed')
    await expect(mainMotor).not.toBeChecked()
    await expect(mainMotor).toBeDisabled()
    expect(await page.evaluate(() => window.labDesktop!.request<any[]>('records.list'))).toEqual([])
    await setFlags({})
    await page.getByRole('button', { name: '连接主面板真实电机', exact: true }).click()
    await expect(mainMotor).toBeEnabled()
    await expect(page.locator('.device').filter({ has: mainMotor }).getByText('待机 · 0 r/min', { exact: true })).toBeVisible()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    const mainMotor2 = page.getByRole('switch', { name: '2 号电机启停', exact: true })
    await expect(mainMotor2).toBeEnabled()
    await expect(page.locator('.device').filter({ has: mainMotor2 }).getByText('待机 · 0 r/min', { exact: true })).toBeVisible()
    await mainMotor2.click()
    await expect(mainMotor2).toBeChecked()
    await setFlags({ dropStopAck: true })
    const beforeUnknownStop = (await readFile(journal, 'utf8')).trim().split('\n').length
    await stop1.click()
    await expect.poll(async () => {
      const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
      return status.state
    }).toBe('failed')
    const unknownStopPackets = (await readFile(journal, 'utf8')).trim().split('\n').slice(beforeUnknownStop).map(line => JSON.parse(line))
    expect(unknownStopPackets.filter(packet => packet[1] === 6 && packet[2] === 0x4e)).toEqual([[1, 6, 0x4e, 0x20], [2, 6, 0x4e, 0x40]])
    await expect(mainMotor).not.toBeChecked()
    await expect(mainMotor2).not.toBeChecked()
    await setFlags({})
    await page.getByRole('button', { name: '连接主面板真实电机', exact: true }).click()
    await expect(page.locator('.device').filter({ has: mainMotor }).getByText('待机 · 0 r/min', { exact: true })).toBeVisible()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    const beforeExpiry = (await readFile(journal, 'utf8')).trim().split('\n').length
    await app.evaluate(() => {
      const now = performance.now.bind(performance)
      ;(globalThis as any).__jogClock = now
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 14 * 60000 })
    })
    await page.evaluate(async () => {
      for (let index = 0; index < 5; index++) await window.labDesktop!.request('hardware.motor.status')
    })
    await app.evaluate(() => {
      const now = (globalThis as any).__jogClock as () => number
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 16 * 60000 })
    })
    try {
      await expect(page.getByRole('button', { name: '验证研发权限', exact: true })).toBeVisible()
      await expect(mainMotor).not.toBeChecked()
      await expect.poll(async () => {
        const lines = (await readFile(journal, 'utf8')).trim().split('\n').slice(beforeExpiry).map(line => JSON.parse(line))
        return lines.filter(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 0x40).map(packet => packet[0])
      }).toEqual(expect.arrayContaining([1, 2]))
    } finally {
      await app.evaluate(() => { delete (performance as any).now; delete (globalThis as any).__jogClock })
    }
    await page.evaluate(() => window.labDesktop!.loginDeviceDebug('test-engineer', 'jog-ui-tests-only'))
    await expect.poll(async () => (await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))).state).toBe('disconnected')
    await page.evaluate(() => window.labDesktop!.restartController())
    await expect(page.getByText('真实硬件控制', { exact: true })).toBeVisible()
    await expect(mainMotor).not.toBeChecked()
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
