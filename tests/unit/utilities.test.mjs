import assert from 'node:assert/strict'
import test from 'node:test'
import { samplesToCsv } from '../../src/shared/csv.ts'
import { pressureAt } from '../../src/renderer/src/graphics/pressureMap.ts'

test('CSV pages have one BOM/header and preserve units and precision', () => {
  const at = '2026-10-28T01:00:00.000Z'
  const row = { time: at, normal: 10, area: 20, friction: 3, speed: 4, coefficient: 0.3, pressure: 0.35 }
  const contents = samplesToCsv([]) + samplesToCsv([row], false)
  assert.equal(contents.charCodeAt(0), 0xfeff)
  assert.equal(contents.split('\ufeff').length, 2)
  assert.equal(contents.split('\r\n')[1], `${at},10.00,20.00,3.00,4.00,0.300,0.35,13.60,7.40`)
})

test('inactive pressure map is blank; both simulation modes are bounded', () => {
  for (const mode of ['press', 'grip']) {
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const value = pressureAt(x, y, mode, 100, true)
      assert.ok(value >= 0 && value <= 0.99)
      assert.equal(pressureAt(x, y, mode, 100, false), 0)
    }
  }
})
