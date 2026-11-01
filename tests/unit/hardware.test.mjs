import assert from 'node:assert/strict'
import test from 'node:test'
import { displacementAddress, convertDisplacement, decodeTension, decodeDisplacementFloat } from '../../src/shared/hardware.ts'
const p = { model: 'p', channel: 1, reading: 'raw', rawMin: 0, rawMax: 5000, lower: 0, upper: 100 }
test('displacement P/G address selection and conversion do not double-scale float values', () => {
  assert.equal(displacementAddress(p), 0)
  assert.equal(displacementAddress({ ...p, reading: 'float' }), 2)
  assert.equal(displacementAddress({ ...p, model: 'g', channel: 3 }), 2)
  assert.equal(displacementAddress({ ...p, model: 'g', channel: 3, reading: 'float' }), 10)
  assert.equal(convertDisplacement(2500, p), 50)
  assert.equal(convertDisplacement(12.5, { ...p, reading: 'float' }), 12.5)
  assert.throws(() => convertDisplacement(5001, p), /超出/)
  assert.throws(() => convertDisplacement(0, { ...p, rawMax: 0 }), /范围/)
  assert.throws(() => displacementAddress({ ...p, model: '' }), /类型/)
  assert.throws(() => convertDisplacement(NaN, p), /有效/)
})
test('sensor register decoding handles signed low-word-first tension and big-endian float32', () => {
  assert.equal(decodeTension(1234, 0, 2), 12.34)
  assert.equal(decodeTension(65535, 65535, 2), -0.01)
  assert.equal(decodeDisplacementFloat(0x4248, 0), 50)
  assert.throws(() => decodeDisplacementFloat(0x7f80, 0), /有效/)
  assert.throws(() => decodeTension(0, 0, -1), /无效/)
})
