import assert from 'node:assert/strict'
import { test } from 'node:test'
import { animateDelta, codeSource, deltaEntrance, splitDeltaText } from '../src/lib/markdown-deltas.ts'

test('new delta fragments resume the same timeline and cancel on unmount', () => {
  const calls = []
  let canceled = false
  const animation = { currentTime: null, cancel: () => { canceled = true } }
  const element = { animate: (...args) => { calls.push(args); return animation } }
  const stop = animateDelta(element, 100, false, 140)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].duration, deltaEntrance.duration)
  assert.equal(animation.currentTime, 40)
  stop()
  assert.equal(canceled, true)
  animateDelta(element, 100, false, 180)
  assert.equal(animation.currentTime, 80, 'a remount resumes instead of replaying')
})

test('history, reduced motion, and unavailable browser animation APIs stay static', () => {
  const element = { animate: () => { throw new Error('Animation should not run') } }
  assert.equal(animateDelta(element, 0, false, 1000), undefined)
  assert.equal(animateDelta(element, 10, true, 20), undefined)
  assert.equal(animateDelta(null, 10, false, 20), undefined)
  assert.equal(animateDelta({}, 10, false, 20), undefined)
})

test('decoded entities and escapes use source delta boundaries', () => {
  const raw = 'AT&amp;T \\* literal'
  const deltas = [
    { id: 'a', start: 0, end: 5, startedAt: 10 },
    { id: 'b', start: 5, end: raw.length, startedAt: 20 },
  ]
  const parts = splitDeltaText('AT&T * literal', raw, 0, deltas)
  assert.deepEqual(parts.map(({ text, delta }) => [text, delta.id]), [['AT', 'a'], ['&T * literal', 'b']])
})

test('a grapheme split across deltas enters once when it is complete', () => {
  const text = 'e\u0301👩‍💻'
  const parts = splitDeltaText(text, text, 0, [
    { id: 'first', start: 0, end: 1, startedAt: 0 },
    { id: 'second', start: 1, end: text.length, startedAt: 10 },
  ])
  assert.equal(parts.length, 1)
  assert.equal(parts[0].text, text)
  assert.equal(parts[0].delta.id, 'second')
})

test('code mapping preserves literal entities, escaped punctuation and indentation', () => {
  const raw = '  &amp; \\*\nnext'
  const parts = splitDeltaText(raw, raw, 12, [
    { id: 'one', start: 12, end: 20, startedAt: 0 },
    { id: 'two', start: 20, end: 12 + raw.length, startedAt: 10 },
  ], false)
  assert.equal(parts.map(({ text }) => text).join(''), raw)
  assert.equal(parts[0].text, raw.slice(0, 8))
})

test('fence tracking handles incomplete, longer and tilde fences', () => {
  assert.deepEqual(codeSource('```js\nconst a =', 2), { raw: 'const a =', start: 8, closed: false })
  assert.equal(codeSource('````md\n```\n````', 0).raw, '```')
  assert.equal(codeSource('~~~js\nconst a = 1\n~~~~', 0).closed, true)
  assert.equal(codeSource('~~~js\nconst a = 1\n```', 0).closed, false)
})
