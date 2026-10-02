import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composerSize } from '../src/lib/composer-size.ts'

test('empty and one-line drafts stay pill sized; wrapping expands the field', () => {
  assert.deepEqual(composerSize(36, 24, 12), { height: 36, expanded: false, scrollable: false })
  assert.deepEqual(composerSize(60, 24, 12), { height: 60, expanded: true, scrollable: false })
  assert.deepEqual(composerSize(84, 24, 12), { height: 84, expanded: true, scrollable: false })
})

test('long drafts stop growing at the cap and scroll; deleting returns to a pill', () => {
  assert.deepEqual(composerSize(252, 26, 18), { height: 192, expanded: true, scrollable: true })
  assert.deepEqual(composerSize(192, 26, 18), { height: 192, expanded: true, scrollable: false })
  assert.deepEqual(composerSize(36, 24, 12), { height: 36, expanded: false, scrollable: false })
})

test('larger text metrics preserve the single-line shape without clipping', () => {
  assert.deepEqual(composerSize(50, 32, 18), { height: 50, expanded: false, scrollable: false })
})

test('a draft wrapping in the pill stays expanded when the wider field fits it on one line', () => {
  assert.deepEqual(composerSize(36, 24, 12, 192, 60), {
    height: 36, expanded: true, scrollable: false,
  })
})
