import assert from 'node:assert/strict'
import test from 'node:test'
import { createPacedText, responsePacing } from '../src/lib/paced-text.ts'
import { seededRandom } from '../src/lib/stream-rhythm.ts'
import { createPacingClock } from './helpers/pacing-clock.mjs'

function setup(onChunk) {
  const clock = createPacingClock()
  const chunks = []
  const delays = []
  const times = []
  let drained = 0
  const schedule = (callback, delay) => { delays.push(delay); return clock.schedule(callback, delay) }
  const pacing = createPacedText((text) => {
    chunks.push(text); times.push(clock.now()); onChunk?.(text)
  }, () => drained++, schedule, clock.now, seededRandom(2))
  return { clock, chunks, delays, times, pacing, get drained() { return drained } }
}

test('short network fragments accumulate and appear on the next cadence without polling', () => {
  const f = setup()
  f.pacing.push('Hel')
  f.pacing.push('lo')
  f.clock.advance(39)
  assert.deepEqual(f.chunks, [])
  f.clock.advance(36)
  assert.deepEqual(f.chunks, ['Hello'])
  assert.equal(f.clock.pending, 0)
  f.clock.advance(5000)
  f.pacing.push(' again')
  f.clock.advance(75)
  assert.deepEqual(f.chunks, ['Hello', ' again'])
  f.pacing.finish()
  assert.equal(f.drained, 1)
  f.pacing.push('stale')
  f.pacing.finish()
  assert.equal(f.drained, 1)
})

test('ordinary updates vary cadence and prefer nearby word boundaries', () => {
  const f = setup()
  f.pacing.push('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda')
  f.clock.advance(200)
  assert.ok(f.times.length >= 3)
  assert.ok(new Set(f.delays).size > 1)
  assert.ok(f.delays.every((delay) => delay >= 40 && delay <= 75))
  const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
  let displayed = 0
  for (const chunk of f.chunks) {
    displayed += chunk.length
    assert.ok(displayed === source.length || /\s/.test(source[displayed]) || /\s/.test(source[displayed - 1]))
  }
})

test('large bursts recover continuously and no received text waits beyond the age deadline', () => {
  const f = setup()
  const source = 'word '.repeat(1200)
  f.pacing.push(source)
  f.clock.advance(75)
  assert.ok(f.chunks[0].length > 40)
  assert.ok(f.chunks[0].length < source.length)
  f.clock.advance(responsePacing.maxAgeMs - 75)
  assert.equal(f.chunks.join(''), source)
  assert.equal(f.clock.pending, 0)
  assert.equal(f.drained, 0)
})

test('continuous arrivals respect their own timestamps while presentation catches up', () => {
  const f = setup()
  const arrivals = []
  let source = ''
  for (let index = 0; index < 20; index++) {
    const text = 'delta '.repeat(30)
    source += text
    arrivals.push({ end: source.length, at: f.clock.now() })
    f.pacing.push(text)
    f.clock.advance(25)
    const displayed = f.chunks.join('').length
    for (const arrival of arrivals) {
      if (f.clock.now() - arrival.at >= responsePacing.maxAgeMs) assert.ok(displayed >= arrival.end)
    }
  }
  f.clock.advance(responsePacing.maxAgeMs)
  assert.equal(f.chunks.join(''), source)
})

test('network completion uses a fixed short deadline, including huge queues and repeated finish calls', () => {
  for (const source of ['Short reply.', 'word '.repeat(3000)]) {
    const f = setup()
    f.pacing.push(source)
    f.clock.advance(20)
    const finishedAt = f.clock.now()
    f.pacing.finish()
    f.clock.advance(100)
    f.pacing.finish()
    f.clock.advance(responsePacing.finishMs - 100)
    assert.equal(f.chunks.join(''), source)
    assert.equal(f.drained, 1)
    assert.equal(f.clock.pending, 0)
    assert.ok(f.times.at(-1) <= finishedAt + responsePacing.finishMs)
  }
})

test('sentence pauses apply only with little backlog, and code punctuation never adds pauses', () => {
  const prose = setup()
  prose.pacing.push('A sentence. More text follows.')
  prose.clock.advance(75)
  assert.ok(prose.delays[1] > 75)
  const code = setup()
  code.pacing.push('```js\n')
  code.clock.advance(75)
  code.pacing.push('value = 1.\nnext = 2.\nlast = 3.\n')
  code.clock.advance(130)
  assert.ok(code.delays.every((delay) => delay >= 0 && delay <= 75))
})

test('Markdown, exact whitespace and Unicode graphemes survive adaptive chunks', () => {
  const sources = [
    '# Heading\n\n> Quote\n\n```js\n  const value = "<tag>";\n```\n\n- **Item**\n',
    'a'.repeat(150) + ' 👩🏽‍💻 e\u0301 👨‍👩‍👧‍👦',
    '你好世界，这是逐步呈现的回答。日本語もそのまま表示します。',
  ]
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const source of sources) {
    const f = setup()
    f.pacing.push(source)
    f.pacing.finish()
    f.clock.flush()
    assert.equal(f.chunks.join(''), source)
    const boundaries = new Set([...graphemes.segment(source)].map((segment) => segment.index))
    boundaries.add(source.length)
    let displayed = 0
    for (const chunk of f.chunks) { displayed += chunk.length; assert.ok(boundaries.has(displayed)) }
  }
})

test('a suspended scheduler catches up in one update on resuming, without extending completion', () => {
  const f = setup()
  const source = 'word '.repeat(300)
  f.pacing.push(source)
  f.pacing.finish()
  f.clock.stall(2000)
  f.clock.advance(0)
  assert.deepEqual(f.chunks, [source])
  assert.equal(f.drained, 1)
})

test('cancel clears queued work and never completes; cancellation inside onChunk is also safe', () => {
  const f = setup()
  f.pacing.push('first second third '.repeat(100))
  f.clock.advance(75)
  const displayed = f.chunks.join('')
  f.pacing.cancel()
  assert.equal(f.clock.pending, 0)
  f.clock.advance(1000)
  f.pacing.finish()
  assert.equal(f.chunks.join(''), displayed)
  assert.equal(f.drained, 0)
  let pacing
  const reentrant = setup(() => pacing.cancel())
  pacing = reentrant.pacing
  pacing.push('first second third '.repeat(100))
  pacing.finish()
  reentrant.clock.flush()
  assert.equal(reentrant.chunks.length, 1)
  assert.equal(reentrant.drained, 0)
  assert.equal(reentrant.clock.pending, 0)
})
