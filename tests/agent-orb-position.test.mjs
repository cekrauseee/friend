import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineOrbPosition } from '../src/lib/agent-orb-position.ts'

const origin = { left: 16, top: 8, width: 32, height: 32 }

test('the streaming orb follows the last word and centers on its line', () => {
  assert.deepEqual(inlineOrbPosition({ left: 100, right: 180, top: 20, height: 26 }, origin), {
    x: 172, y: 9,
  })
  // A wrapped word moves the same orb back to the beginning of the new line.
  assert.deepEqual(inlineOrbPosition({ left: 16, right: 64, top: 46, height: 26 }, origin), {
    x: 56, y: 35,
  })
})

test('scrolling shifts text and its origin equally without moving the relative target', () => {
  const text = { left: 100, right: 180, top: 20, height: 26 }
  assert.deepEqual(
    inlineOrbPosition({ ...text, top: text.top - 120 }, { ...origin, top: origin.top - 120 }),
    inlineOrbPosition(text, origin),
  )
})

test('RTL text places the orb after the word in its reading direction', () => {
  assert.deepEqual(inlineOrbPosition({ left: 100, right: 180, top: 20, height: 26 }, origin, true), {
    x: 44, y: 9,
  })
})
