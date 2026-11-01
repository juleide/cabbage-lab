import { openDeviceConnection } from './engineering'
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
    LAB_DEVICE_DEBUG_PASSWORD: 'jog-ui-tests-only'
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
    await openDeviceConnection(page)
    await page.getByLabel('密码', { exact: true }).fill('jog-ui-tests-only')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByRole('button', { name: '执行机构', exact: true }).click()
    const panel = page.getByRole('region', { name: '真实电机启停', exact: true })
    const motor1 = panel.getByRole('article', { name: '1 号电机真实控制', exact: true })
    const motor2 = panel.getByRole('article', { name: '2 号电机真实控制', exact: true })
    await expect(motor1.getByRole('button', { name: '启动 1 号电机', exact: true })).toBeEnabled()
    let packets = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(packets.every(packet => packet[1] === 3)).toBe(true)
    const previousSession = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
    await page.getByRole('article', { name: '1 号电机固定运行参数', exact: true })
      .getByLabel('运行速度（r/min）', { exact: true }).fill('40')
    await page.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect.poll(async () => {
      const status = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
      return status?.sessionId !== previousSession.sessionId && status?.axes.motor1.canStart
    }).toBe(true)
    const appliedSession = await page.evaluate(() => window.labDesktop!.request<any>('hardware.motor.status'))
    await expect(panel.getByRole('status')).toContainText(appliedSession.sessionId.slice(0, 8))
    await expect(motor1.getByRole('button', { name: '启动 1 号电机', exact: true })).toBeEnabled()
    expect(JSON.parse(await readFile(join(data, 'config', 'hardware.json'), 'utf8')).motors.operation.motor1.speedRpm).toBe(40)
    packets = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(packets.some(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 8)).toBe(false)
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
    await expect(page.getByRole('switch')).toHaveCount(3)
    await expect(page.getByRole('button', { name: '验证主面板权限', exact: true })).toHaveCount(0)
    const mainMotor = page.getByRole('switch', { name: '1 号电机启停', exact: true })
    const mainMotor2 = page.getByRole('switch', { name: '2 号电机启停', exact: true })
    await page.evaluate(() => window.labDesktop!.restartController())
    await expect(mainMotor).toBeEnabled()
    await expect(mainMotor).not.toBeChecked()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    await setFlags({ dropSpeed: true })
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('state.get'))
      return snapshot.state.motorControl.state
    }).toBe('failed')
    await expect(mainMotor).not.toBeChecked()
    expect(await page.evaluate(() => window.labDesktop!.request<any[]>('records.list'))).toEqual([])
    await setFlags({})
    await page.evaluate(() => window.labDesktop!.restartController())
    await expect(mainMotor).toBeEnabled()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    await mainMotor2.click()
    await expect(mainMotor2).toBeChecked()
    await setFlags({ dropStopAck: true })
    const beforeUnknownStop = (await readFile(journal, 'utf8')).trim().split('\n').length
    await mainMotor.click()
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('state.get'))
      return snapshot.state.motorControl.state
    }).toBe('failed')
    const unknownStopPackets = (await readFile(journal, 'utf8')).trim().split('\n').slice(beforeUnknownStop).map(line => JSON.parse(line))
    expect(unknownStopPackets.filter(packet => packet[1] === 6 && packet[2] === 0x4e)).toEqual([[1, 6, 0x4e, 0x20], [2, 6, 0x4e, 0x40]])
    await expect(mainMotor).not.toBeChecked()
    await expect(mainMotor2).not.toBeChecked()
    await setFlags({})
    await page.evaluate(() => window.labDesktop!.restartController())
    await expect(mainMotor).toBeEnabled()
    await mainMotor.click()
    await expect(mainMotor).toBeChecked()
    await page.evaluate(() => window.labDesktop!.loginDeviceDebug('jog-ui-tests-only'))
    const beforeExpiry = (await readFile(journal, 'utf8')).trim().split('\n').length
    await app.evaluate(() => {
      const now = performance.now.bind(performance)
      Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + 16 * 60000 })
    })
    try {
      await expect.poll(async () => (await page.evaluate(() => window.labDesktop!.getDeviceDebugAuth())).authorized).toBe(false)
      await expect(mainMotor).not.toBeChecked()
      await expect.poll(async () => {
        const lines = (await readFile(journal, 'utf8')).trim().split('\n').slice(beforeExpiry).map(line => JSON.parse(line))
        return lines.filter(packet => packet[1] === 6 && packet[2] === 0x4e && packet[3] === 0x40).map(packet => packet[0])
      }).toEqual(expect.arrayContaining([1, 2]))
    } finally {
      await app.evaluate(() => { delete (performance as any).now })
    }
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
