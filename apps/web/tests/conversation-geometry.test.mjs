import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeReplyGrowth,
  consumeUpwardScroll,
  distanceToRealEnd,
  jumpTarget,
  sendAlignment,
} from '../src/lib/conversation-geometry.ts'

test('send reuses the remaining spacer before adding only the missing reach', () => {
  assert.deepEqual(sendAlignment({ userTop: 420, topInset: 12, scrollHeight: 700, clientHeight: 250, spacerPx: 120 }),
    { target: 408, extra: 0, spacerPx: 120 })
  assert.deepEqual(sendAlignment({ userTop: 530, topInset: 12, scrollHeight: 700, clientHeight: 250, spacerPx: 120 }),
    { target: 518, extra: 68, spacerPx: 188 })
})

test('reply growth consumes spacer without restoring it on shrink or retry reset', () => {
  const grown = consumeReplyGrowth(90, 20, 55)
  assert.deepEqual(grown, { spacerPx: 55, maxHeightSeen: 55 })
  assert.deepEqual(consumeReplyGrowth(grown.spacerPx, grown.maxHeightSeen, 32), grown)
  assert.deepEqual(consumeReplyGrowth(grown.spacerPx, grown.maxHeightSeen, 150),
    { spacerPx: 0, maxHeightSeen: 150 })
  assert.deepEqual(consumeReplyGrowth(0, 0, 25), { spacerPx: 0, maxHeightSeen: 25 })
})

test('only a real upward scroll consumes remaining spacer', () => {
  assert.equal(consumeUpwardScroll(30, 100, 82), 12)
  assert.equal(consumeUpwardScroll(30, 100, 150), 30)
  assert.equal(consumeUpwardScroll(30, 100, 20), 0)
  assert.equal(consumeUpwardScroll(30, 100, 20, true), 30)
})

test('jump uses the real end, while send reach includes the spacer', () => {
  const alignment = sendAlignment({ userTop: 610, topInset: 10, scrollHeight: 900, clientHeight: 300, spacerPx: 220 })
  assert.equal(alignment.extra, 0)
  assert.equal(distanceToRealEnd(590, 300, 300), -10)
  assert.equal(jumpTarget(810, 300, 900), 526)
  assert.equal(jumpTarget(100, 300, 900), 0)
})

test('fractional geometry remains bounded', () => {
  const result = sendAlignment({ userTop: 100.25, topInset: 12.5, scrollHeight: 150.5, clientHeight: 100, spacerPx: 4.25 })
  assert.deepEqual(result, { target: 87.75, extra: 37.25, spacerPx: 41.5 })
  assert.equal(consumeUpwardScroll(0.25, 5.25, 4.5), 0)
})
