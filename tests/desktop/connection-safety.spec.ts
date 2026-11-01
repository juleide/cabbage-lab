import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const triggerGuard of [false, true]) {
test(`real IPC ${triggerGuard ? 'diagnostic guard' : 'debug lock'} stops both fake motor stations before closing their port`, async () => {
  const data = await mkdtemp(join(tmpdir(), 'lab-motion-ipc-'))
  const journal = join(data, 'serial-events.jsonl')
  const signal = join(data, 'inject-running')
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
        if data[1] == 3:
            word = 4 if os.path.exists(os.environ['LAB_MOTION_GUARD_SIGNAL']) else 16
            payload = bytes([0, word]) if data[3] == 4 else bytes([0, 0, 19, 136])
            self.buffer.extend(frame(bytes([data[0], 3, len(payload)]) + payload))
        if data[1] == 6: self.buffer.extend(data)
        return len(data)
    def read(self, size):
        time.sleep(0.005)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result
`)
  const app = await electron.launch({ args: ['.', `--user-data-dir=${join(data, 'ui')}`], env: { ...process.env, LAB_DATA_DIR: data, PYTHONPATH: data, LAB_MOTION_TEST_WRITES: journal, LAB_MOTION_GUARD_SIGNAL: signal, LAB_DEVICE_DEBUG_PASSWORD: 'motion-ipc-tests-only' } }).catch(async error => { await rm(data, { recursive: true, force: true }); throw error })
  try {
    const page = await app.firstWindow()
    await expect(page.getByText(/设备未就绪|设备异常/, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.labDesktop!.loginDeviceDebug('motion-ipc-tests-only'))).toMatchObject({ authorized: true })
    await page.evaluate(async () => {
      const snapshot = await window.labDesktop!.request<any>('hardware.get')
      const config = snapshot.config
      Object.assign(config.motors.serial, { port: 'OFFLINE-FAKE-MOTORS', baud: 9600 })
      config.motors.motor1 = 1; config.motors.motor2 = 2
      await window.labDesktop!.request('hardware.save', { config })
      await window.labDesktop!.request('hardware.motion.connect', { section: 'motors' })
    })
    const status = () => page.evaluate(() => window.labDesktop!.request<any>('hardware.motion.status'))
    const readJournal = async () => (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; hex?: string })
    await expect.poll(async () => (await status()).motors?.diagnosticGuard.state).toBe('observing')
    await expect.poll(async () => (await status()).motors?.readings.motor2?.position?.rawUnsigned).toBe(5000)
    expect((await readJournal()).filter(event => event.kind === 'write').every(event => event.hex!.slice(2, 4) === '03')).toBe(true)
    if (triggerGuard) {
      await writeFile(signal, 'inject running bit')
      await expect.poll(async () => (await status()).motors?.diagnosticGuard.state).toBe('tripped')
    } else {
      await page.evaluate(() => window.labDesktop!.lockDeviceDebug())
      const denied = await page.evaluate(async () => {
        try { await window.labDesktop!.request('hardware.motion.status'); return '' }
        catch (error) { return (error as Error).message }
      })
      expect(denied).toContain('未解锁或已过期')
    }
    await expect.poll(async () => (await readJournal()).at(-1)?.kind).toBe('close')
    const events = await readJournal()
    const stops = events.filter(event => event.kind === 'write' && event.hex!.slice(2, 4) === '06')
    expect(stops.map(event => event.hex!.slice(0, 12)).sort()).toEqual(['0106004e0040', '0206004e0040'])
    expect(events.filter(event => event.kind === 'open')).toHaveLength(1)
    if (!triggerGuard) await page.evaluate(() => window.labDesktop!.loginDeviceDebug('motion-ipc-tests-only'))
    const motors = (await status()).motors
    expect(motors.state).toBe(triggerGuard ? 'failed' : 'disconnected')
    expect(motors.diagnosticGuard.state).toBe(triggerGuard ? 'tripped' : 'closed')
    expect(motors.faultLatched).toBe(true)
    expect(Object.values(motors.commands).every((command: any) => command.state === 'acknowledged' && !command.motionConfirmed)).toBe(true)
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
    await app.close().catch(() => {})
    await rm(data, { recursive: true, force: true })
  }
})
}
