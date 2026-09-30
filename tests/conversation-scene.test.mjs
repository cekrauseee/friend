import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idleSceneOffsets } from '../src/lib/conversation-scene.ts'

test('idle orb and controls stay centered with a fixed gap across viewport and composer sizes', () => {
  for (const [height, orbHeight, footerHeight] of [[800, 160, 60], [500, 100, 64], [800, 160, 240]]) {
    const { composerOffset, orbOffset } = idleSceneOffsets(height, orbHeight, footerHeight, 16)
    const orbTop = height / 2 + orbOffset
    const composerTop = height - footerHeight + composerOffset
    assert.equal(composerTop - (orbTop + orbHeight), 24)
    assert.equal((orbTop + composerTop + footerHeight) / 2, (height + 16) / 2)
  }
})

test('growing the composer shifts both anchors symmetrically without closing their gap', () => {
  const a = idleSceneOffsets(800, 160, 60, 16)
  const b = idleSceneOffsets(800, 160, 180, 16)
  assert.equal(b.composerOffset - a.composerOffset, 60)
  assert.equal(b.orbOffset - a.orbOffset, -60)
})
