import assert from 'node:assert/strict'
import test from 'node:test'
import { attachConversationScrollMotion } from '../src/lib/conversation-scroll-motion.ts'

function fixture(reducedMotion = false) {
  const originals = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, performance: globalThis.performance, window: globalThis.window }
  let now = 0
  let nextFrame = 0
  const frames = new Map()
  globalThis.performance = { now: () => now }
  globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) }
  globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  const node = {
    scrollTop: 0, scrollHeight: 1100, clientHeight: 600,
    scrollTo(options) { this.scrollTop = Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight) },
  }
  const originalScrollTo = node.scrollTo
  const motion = attachConversationScrollMotion(node)
  return {
    node, motion, originalScrollTo,
    frame(elapsed) {
      now += elapsed
      const queued = [...frames.values()]
      frames.clear()
      queued.forEach((callback) => callback(now))
    },
    restore() { motion.dispose(); Object.assign(globalThis, originals) },
  }
}

test('automatic commands and streamed growth leave the viewport in place', () => {
  const f = fixture()
  try {
    f.node.scrollTop = 120
    f.node.scrollTo({ top: 488, behavior: 'auto' })
    f.frame(250)
    assert.equal(f.node.scrollTop, 120)
    f.node.scrollHeight = 1800
    f.node.scrollTo({ top: 1200, behavior: 'auto' })
    f.frame(250)
    assert.equal(f.node.scrollTop, 120)
  } finally { f.restore() }
})

test('jump-to-latest smooth commands use the same curve and duration', () => {
  const f = fixture()
  try {
    f.node.scrollTo({ top: 488, behavior: 'smooth' })
    f.frame(122)
    assert.equal(f.node.scrollTop, 244)
    f.frame(122)
    assert.equal(f.node.scrollTop, 488)
  } finally { f.restore() }
})

test('automatic resize commands cannot retarget an explicit reader jump', () => {
  const f = fixture()
  try {
    f.node.scrollTo({ top: 400, behavior: 'smooth' })
    f.frame(100)
    assert.equal(f.node.scrollTop, 200)
    f.node.scrollTo({ top: 480, behavior: 'auto' })
    assert.equal(f.node.scrollTop, 200)
    f.frame(100)
    assert.equal(f.node.scrollTop, 400)
  } finally { f.restore() }
})

test('reader intent cancels the jump and automatic content commands stay ignored', () => {
  const f = fixture()
  try {
    f.node.scrollTo({ top: 488, behavior: 'smooth' })
    f.frame(60)
    const stoppedAt = f.node.scrollTop
    f.motion.cancel()
    f.frame(500)
    assert.equal(f.node.scrollTop, stoppedAt)
    f.node.scrollTo({ top: 300, behavior: 'auto' })
    assert.equal(f.node.scrollTop, stoppedAt)
  } finally { f.restore() }
})

test('reduced motion makes explicit reader jumps immediate', () => {
  const f = fixture(true)
  try {
    f.node.scrollTo({ top: 488, behavior: 'smooth' })
    assert.equal(f.node.scrollTop, 488)
    f.node.scrollTo({ top: 100, behavior: 'smooth' })
    assert.equal(f.node.scrollTop, 100)
  } finally { f.restore() }
})

test('dispose cancels the motion and restores the native viewport method', () => {
  const f = fixture()
  try {
    f.node.scrollTo({ top: 488, behavior: 'smooth' })
    f.motion.dispose()
    f.frame(500)
    assert.equal(f.node.scrollTop, 0)
    assert.equal(f.node.scrollTo, f.originalScrollTo)
  } finally { f.restore() }
})
