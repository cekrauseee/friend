import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waveformLayout } from '../src/lib/waveform-layout.ts'

test('waveform bars have equal left and right margins, including widths with a partial bar', () => {
  for (const width of [160, 173, 160.5]) {
    const { count, step, startX } = waveformLayout(width, 3, 3)
    const right = width - (startX + (count - 1) * step + 3)
    assert.equal(startX, right)
    assert.ok(startX >= 0)
    assert.ok(startX < step)
  }
})
