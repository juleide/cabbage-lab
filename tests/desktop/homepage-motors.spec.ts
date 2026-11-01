import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('original homepage starts and stops real motor sessions without developer login', async () => {
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
    const motor1 = page.getByRole('switch', { name: '1 号电机启停', exact: true })
    const motor2 = page.getByRole('switch', { name: '2 号电机启停', exact: true })
    await expect(motor1).toBeEnabled()
    await expect(motor2).toBeEnabled()
    const packets = async () => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect((await packets()).every(packet => packet[1] === 3)).toBe(true)
    await motor1.click()
    await expect(motor1).toBeChecked()
    await motor2.click()
    await expect(motor2).toBeChecked()
    await motor1.click()
    await expect(motor1).not.toBeChecked()
    await expect(motor2).toBeChecked()
    await motor2.click()
    await expect(motor2).not.toBeChecked()
    await expect(motor1).toBeEnabled()
    await setFlags({ blockSetup: true })
    const before = (await packets()).length
    await motor1.click()
    await expect.poll(async () => (await packets()).slice(before).some(packet => packet[2] === 0x31),
      { intervals: [10, 20, 30] }).toBe(true)
    await expect(page.locator('.device').filter({ has: motor1 }).getByText('启动中', { exact: true })).toBeVisible()
    await expect(motor1).toBeEnabled()
    await motor1.click()
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => window.labDesktop!.request<any>('state.get'))
      return snapshot.state.motorControl.axes.motor1.state
    }).toBe('idle')
    expect((await packets()).slice(before).filter(packet => packet[2] === 0x4e && packet[3] === 8)).toEqual([])
    await setFlags({})
    await expect(page.getByRole('switch', { name: '升降装置启停', exact: true })).toBeDisabled()
    for (const name of ['初始化', '轴回零', '传感器置零', '联动开始']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    }
    expect(await page.evaluate(() => window.labDesktop!.request<any[]>('records.list'))).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
