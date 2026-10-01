import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisualRhythm, seededRandom, visualRhythm } from '../src/lib/stream-rhythm.ts'
import { createAgentTyping, agentTypingRhythm } from '../src/lib/agent-typing.ts'
import { createPacedText, responsePacing } from '../src/lib/paced-text.ts'
import { createPacingClock } from './helpers/pacing-clock.mjs'

function sequence(seed) {
  const rhythm = createVisualRhythm(seededRandom(seed))
  const values = []
  let time = 0
  for (let index = 0; index < 40; index++) {
    const next = rhythm.next(time)
    values.push(next - time)
    time = next
    rhythm.markVisible(time)
  }
  return values
}

test('visual timing is reproducible by seed, bounded and no longer repeats an eight-beat cycle', () => {
  const first = sequence(2)
  assert.deepEqual(sequence(2), first)
  assert.notDeepEqual(sequence(3), first)
  assert.ok(first.every((interval) => interval >= visualRhythm.minimumMs && interval <= visualRhythm.maximumMs))
  assert.notDeepEqual(first.slice(0, 8), first.slice(8, 16))
})

test('short starvation preserves phase while long silence starts a fresh beat', () => {
  const rhythm = createVisualRhythm(seededRandom(2))
  const first = rhythm.next(0)
  rhythm.markVisible(first)
  const arrival = first + 30
  const next = rhythm.next(arrival)
  assert.ok(next > arrival)
  assert.ok(next - arrival < visualRhythm.minimumMs)
  const afterSilence = arrival + 1000
  const restarted = rhythm.next(afterSilence)
  assert.ok(restarted - afterSilence >= visualRhythm.minimumMs)
  assert.ok(restarted - afterSilence <= visualRhythm.maximumMs)
})

test('periodic input at 50, 100, 200 and 1000ms produces variable sound timings and texture', () => {
  for (const period of [50, 100, 200, 1000]) {
    const clock = createPacingClock()
    const typing = createAgentTyping(clock.now, seededRandom(3))
    const displayed = []
    const played = []
    const pacing = createPacedText((text, accelerated) => {
      displayed.push(clock.now())
      const sound = typing.select(text, accelerated)
      if (sound) played.push({ at: clock.now(), ...sound })
    }, () => {}, clock.schedule, clock.now, seededRandom(2))
    for (let index = 0; index < 60; index++) {
      pacing.push('word ')
      clock.advance(period)
    }
    pacing.finish()
    clock.flush()
    assert.ok(played.length > 5)
    assert.ok(played.length < displayed.length)
    assert.ok(played.every((sound) => displayed.includes(sound.at)))
    const gaps = played.slice(1).map((sound, index) => sound.at - played[index].at)
    assert.ok(gaps.every((gap) => gap >= agentTypingRhythm.minimumMs))
    assert.ok(new Set(gaps.map((gap) => Math.round(gap))).size > 2)
    assert.ok(new Set(played.map((sound) => sound.volume)).size > 2)
    assert.ok(new Set(played.map((sound) => sound.playbackRate)).size > 2)
    assert.ok(played.every((sound) => sound.playbackRate >= 0.97 && sound.playbackRate <= 1.03))
    const count = played.length
    clock.advance(5000)
    assert.equal(played.length, count)
    assert.equal(clock.pending, 0)
  }
})

test('typing ignores whitespace and is softer during recovery without increasing density', () => {
  let time = 0
  const normal = createAgentTyping(() => time, seededRandom(2))
  const recovering = createAgentTyping(() => time, seededRandom(2))
  assert.equal(normal.select(' \n '), null)
  const first = normal.select('word')
  const quiet = recovering.select('word', true)
  assert.ok(first && quiet)
  assert.equal(quiet.volume, first.volume * agentTypingRhythm.recoveryGain)
  assert.equal(quiet.playbackRate, first.playbackRate)
  assert.equal(normal.select('more'), null)
  assert.equal(recovering.select('more', true), null)
  time += 1000
  const second = normal.select('word')
  const secondQuiet = recovering.select('word', true)
  assert.equal(Boolean(second), Boolean(secondQuiet))
})

test('sustained visible updates produce a denser typing cadence without a fixed beat', () => {
  for (const period of [50, 55, 60]) {
    let time = 0
    const typing = createAgentTyping(() => time, seededRandom(3))
    const played = []
    for (; time < 10000; time += period) {
      if (typing.select('new text')) played.push(time)
    }
    // Roughly 7–9 key contacts/second during a steady stream.
    assert.ok(played.length >= 65 && played.length <= 90, `${period}ms updates yielded ${played.length} sounds`)
    const gaps = played.slice(1).map((at, index) => at - played[index])
    assert.ok(gaps.every((gap) => gap >= agentTypingRhythm.minimumMs))
    assert.ok(new Set(gaps).size > 1)
  }
})

test('a network silence satisfies a punctuation pause and whitespace cannot repeat it', () => {
  const clock = createPacingClock()
  const delays = []
  const schedule = (callback, delay) => { delays.push(delay); return clock.schedule(callback, delay) }
  const pacing = createPacedText(() => {}, () => {}, schedule, clock.now, seededRandom(2))
  pacing.push('Sentence.')
  clock.advance(75)
  assert.equal(clock.pending, 0)
  clock.advance(120)
  pacing.push(' ')
  clock.advance(75)
  assert.ok(delays.at(-1) <= 75)
  pacing.push('Next sentence')
  assert.ok(delays.at(-1) <= 75)
  pacing.finish()
  clock.flush()
})

test('rhythm variation still respects content age and completion deadlines under periodic arrivals', () => {
  const clock = createPacingClock()
  let received = ''
  let visible = ''
  const arrivals = []
  const pacing = createPacedText((chunk) => { visible += chunk }, () => {}, clock.schedule, clock.now, seededRandom(42))
  for (let index = 0; index < 30; index++) {
    const text = 'word '.repeat(40)
    received += text
    arrivals.push({ at: clock.now(), end: received.length })
    pacing.push(text)
    clock.advance(50)
    for (const arrival of arrivals) {
      if (clock.now() - arrival.at >= responsePacing.maxAgeMs) assert.ok(visible.length >= arrival.end)
    }
  }
  const finished = clock.now()
  pacing.finish()
  clock.advance(responsePacing.finishMs)
  assert.equal(visible, received)
  assert.equal(clock.now(), finished + responsePacing.finishMs)
  assert.equal(clock.pending, 0)
})
