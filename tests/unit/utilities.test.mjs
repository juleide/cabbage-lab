import assert from 'node:assert/strict'
import test from 'node:test'
import { samplesToCsv } from '../../src/shared/csv.ts'
import { pressureColor } from '../../src/renderer/src/graphics/pressureMap.ts'

test('CSV pages have one BOM/header and preserve units and precision', () => {
  const at = '2026-10-28T01:00:00.000Z'
  const row = { time: at, normal: 10, area: 20, friction: 3, speed: 4, coefficient: 0.3, pressure: 0.35 }
  const contents = samplesToCsv([]) + samplesToCsv([row], false)
  assert.equal(contents.charCodeAt(0), 0xfeff)
  assert.equal(contents.split('\ufeff').length, 2)
  assert.equal(contents.split('\r\n')[1], `${at},10.00,20.00,3.00,4.00,0.300,0.35,13.60,7.40`)
})

test('array color mapping clamps raw samples to the fixed simulation range', () => {
  assert.deepEqual(pressureColor(0), [234, 244, 237])
  assert.deepEqual(pressureColor(4095), [217, 99, 77])
  assert.deepEqual(pressureColor(-1), pressureColor(0))
  assert.deepEqual(pressureColor(65535), pressureColor(4095))
  assert.deepEqual(pressureColor(-100, { minimum: -100, maximum: 100 }), pressureColor(0))
  assert.deepEqual(pressureColor(100, { minimum: -100, maximum: 100 }), pressureColor(4095))
})
