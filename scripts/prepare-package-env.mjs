import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'

const root = process.cwd()
const source = resolve(root, '.env')
const output = resolve(root, 'resources/config/device.env.enc')

const values = parseEnv(await readFile(source, 'utf8'))
const password = values.LAB_DEVICE_DEBUG_PASSWORD
if (!password?.trim()) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, '')
  console.log('device.env.enc: credentials disabled; empty package created')
  process.exit(0)
}

const key = randomBytes(32)
const payload = Buffer.from(`1\n${password}`, 'utf8')
const nonce = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', key, nonce)
const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
const tag = cipher.getAuthTag()
const checksum = createHmac('sha256', key).update(encrypted).digest()
await mkdir(dirname(output), { recursive: true })
await writeFile(output, Buffer.concat([key, nonce, tag, checksum, encrypted]))
console.log('device.env.enc: packaged credentials encrypted')
