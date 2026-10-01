import assert from 'node:assert/strict'
import test from 'node:test'
import { createUISFX, createRecipe, renderRecipe } from 'uisfx'
import { createInterfaceSounds, interfaceSoundCues, interfaceSounds, migrateSoundPreference } from '../src/lib/interface-sounds.ts'
import { conversationOutcomeSound } from '../src/lib/conversation-sound.ts'
import { createTextConversationStore } from '../src/lib/text-conversation.ts'
import { createAgentTyping } from '../src/lib/agent-typing.ts'
import { seededRandom } from '../src/lib/stream-rhythm.ts'
import { createPacingClock } from './helpers/pacing-clock.mjs'

function fixture({ visible = true, ready = true } = {}) {
  let enabled = true
  const played = []
  let soundTime = 0
  let stopped = 0
  let destroyed = 0
  let unlocks = 0
  const player = {
    isEnabled: () => enabled,
    setEnabled: (value) => { enabled = value },
    unlock: async () => { unlocks++; return ready },
    play: (cue, options) => { played.push({ cue, options }); return null },
    stopAll: () => { stopped++ },
    destroy: async () => { destroyed++ },
  }
  const sounds = createInterfaceSounds(player, () => visible, () => createAgentTyping(() => soundTime, seededRandom(2)))
  return { sounds, played, advance: (ms) => { soundTime += ms }, get stopped() { return stopped }, get destroyed() { return destroyed }, get unlocks() { return unlocks } }
}

test('background outcomes stay silent until audio is unlocked by intent', async () => {
  const f = fixture()
  f.sounds.play('receive')
  assert.equal(f.played.length, 0)
  assert.equal(f.unlocks, 0)
  f.sounds.play('send', true)
  assert.equal(f.played[0].cue, 'send')
  await f.sounds.unlock()
  f.sounds.play('receive')
  assert.deepEqual(f.played.map((item) => item.cue), ['send', 'receive'])
})

test('typing cues stay quiet; only streaming updates have an audio cadence cap', async () => {
  const f = fixture()
  await f.sounds.unlock()
  f.sounds.play('composerTyping', true)
  f.sounds.play('composerTyping', true)
  f.sounds.playAgentTyping('one', 'text')
  f.sounds.playAgentTyping('one', 'text')
  assert.equal(f.played.length, 3)
  for (const item of f.played) {
    assert.equal(item.cue, 'typing')
    assert.equal(item.options.retrigger, 'restart')
    assert.notEqual(item.options.loop, true)
  }
  assert.equal(f.played[0].options.cooldownMs, 0)
  assert.equal(f.played[2].options.cooldownMs, 70)
  assert.ok(f.played[2].options.volume < f.played[0].options.volume)
})

test('mute immediately stops audio, notifies controls and blocks all playback', async () => {
  const f = fixture()
  await f.sounds.unlock()
  let notifications = 0
  const unsubscribe = f.sounds.subscribe(() => notifications++)
  f.sounds.setEnabled(false)
  f.sounds.play('send', true)
  f.sounds.playAgentTyping('one', 'text')
  assert.equal(f.stopped, 1)
  assert.equal(f.sounds.getSnapshot(), false)
  assert.equal(f.played.length, 0)
  assert.equal(notifications, 1)
  f.sounds.setEnabled(true)
  await f.sounds.unlock()
  f.sounds.play('send', true)
  assert.equal(f.played[0].cue, 'send')
  unsubscribe()
})

test('preference persists with the package storage and returns muted after recreation', () => {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const make = () => createInterfaceSounds(createUISFX({ pack: 'zen', volume: 0.5, preferences: { key: 'test:sounds', storage } }), () => true)
  const first = make()
  first.setEnabled(false)
  assert.equal(make().getSnapshot(), false)
  assert.equal(JSON.parse(values.get('test:sounds')).enabled, false)
})

test('renaming preserves the saved mute preference without replacing newer Dot settings', () => {
  const saved = JSON.stringify({ enabled: false, pack: 'zen', volume: 0.5 })
  const values = new Map([['friend:interface-sounds', saved]])
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  migrateSoundPreference(storage)
  assert.equal(values.get('dot:interface-sounds'), saved)
  const current = JSON.stringify({ enabled: true })
  values.set('dot:interface-sounds', current)
  migrateSoundPreference(storage)
  assert.equal(values.get('dot:interface-sounds'), current)
})

test('hidden tabs, active voice sessions and failed unlocks suppress asynchronous cues', async () => {
  const hidden = fixture({ visible: false })
  hidden.sounds.play('send', true)
  assert.equal(hidden.played.length, 0)
  const blocked = fixture({ ready: false })
  await blocked.sounds.unlock()
  blocked.sounds.play('receive')
  assert.equal(blocked.played.length, 0)
  const voice = fixture()
  await voice.sounds.unlock()
  voice.sounds.setVoiceActive(true)
  voice.sounds.playAgentTyping('one', 'text')
  voice.sounds.play('send', true)
  assert.equal(voice.stopped, 1)
  assert.equal(voice.played.length, 0)
  voice.sounds.setVoiceActive(false)
  voice.sounds.play('callEnded')
  assert.equal(voice.played[0].cue, 'disconnect')
})

test('stop invalidates an in-flight unlock and prevents stale outcomes', async () => {
  let resolve
  const player = { isEnabled: () => true, unlock: () => new Promise((done) => { resolve = done }), stopAll() {}, play() { assert.fail('Stale sound played') } }
  const sounds = createInterfaceSounds(player, () => true)
  const unlocking = sounds.unlock()
  sounds.stop()
  resolve(true)
  await unlocking
  sounds.play('receive')
})

test('SSR stays silent and disposal destroys the player', async () => {
  assert.equal(interfaceSounds.getSnapshot(), false)
  assert.doesNotThrow(() => interfaceSounds.play('send', true))
  const f = fixture()
  await f.sounds.dispose()
  assert.equal(f.stopped, 1)
  assert.equal(f.destroyed, 1)
})

test('completion and real failure produce one cue; history, cancellation and unrelated renders stay silent', () => {
  const streaming = { id: 'one', status: 'streaming', error: null }
  const complete = { ...streaming, status: 'complete' }
  assert.equal(conversationOutcomeSound(streaming, complete), 'receive')
  assert.equal(conversationOutcomeSound(complete, complete), null)
  assert.equal(conversationOutcomeSound(undefined, complete), null)
  assert.equal(conversationOutcomeSound(streaming, { ...complete, id: 'other' }), null)
  assert.equal(conversationOutcomeSound(streaming, { ...streaming, status: 'failed', error: 'Network failed' }), 'error')
  assert.equal(conversationOutcomeSound(streaming, { ...streaming, status: 'failed', error: 'Reply canceled.' }), null)
  assert.equal(conversationOutcomeSound(streaming, { ...streaming, assistantText: 'More text' }), null)
})

test('a fast response waits for paced display before its completion cue', async () => {
  const f = fixture()
  await f.sounds.unlock()
  const clock = createPacingClock()
  const store = createTextConversationStore(async (_messages, _signal, onDelta) => { onDelta('Hi') }, () => 'one', clock.schedule, clock.now)
  const unsubscribe = store.subscribe((state, previous) => {
    const outcome = conversationOutcomeSound(previous.turns.at(-1), state.turns.at(-1))
    if (outcome) f.sounds.play(outcome)
  })
  store.getState().sendText('Hello')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.played.length, 0)
  assert.equal(store.getState().activeTurnId, 'one')
  clock.flush()
  assert.deepEqual(f.played.map((item) => item.cue), ['receive'])
  store.setState({ mode: 'voice' })
  assert.equal(f.played.length, 1)
  unsubscribe()
})

test('Zen cues have bounded peaks at the configured gains and typing stays softer than outcomes', () => {
  const peaks = {}
  for (const [name, { cue, volume }] of Object.entries(interfaceSoundCues)) {
    const rendered = renderRecipe(createRecipe('zen', cue), 22050)
    peaks[name] = rendered.peak * volume * 0.5
    assert.ok(peaks[name] > 0 && peaks[name] < 0.04, `${name} peak exceeds the quiet gain budget`)
    assert.equal(createRecipe('zen', cue).loop, false)
  }
  assert.ok(peaks.agentTyping < peaks.composerTyping)
  assert.ok(peaks.composerTyping < peaks.send)
  assert.ok(peaks.composerTyping < peaks.receive)
})


test('accent opening/selection/shade/reset use the existing mute and call gates', async () => {
  const actions = ['accentOpen', 'accentSelect', 'accentShade', 'accentReset', 'accentHover']
  for (const gate of ['mute', 'voice', 'hidden']) {
    const f = fixture({ visible: gate !== 'hidden' })
    if (gate === 'mute') f.sounds.setEnabled(false)
    if (gate === 'voice') f.sounds.setVoiceActive(true)
    for (const action of actions) f.sounds.play(action, action !== 'accentHover')
    assert.equal(f.played.length, 0)
  }
  const f = fixture()
  await f.sounds.unlock()
  for (const action of actions) f.sounds.play(action, action !== 'accentHover')
  assert.equal(f.played.length, 5)
  assert.equal(f.played[2].options.cooldownMs, 60)
})


test('color hover reuses quiet typing with a cooldown and cannot unlock audio', async () => {
  const f = fixture()
  f.sounds.play('accentHover')
  assert.equal(f.played.length, 0)
  assert.equal(f.unlocks, 0)
  await f.sounds.unlock()
  f.sounds.play('accentHover')
  assert.equal(f.played[0].cue, 'typing')
  assert.equal(f.played[0].options.cooldownMs, 90)
  assert.equal(f.played[0].options.retrigger, 'restart')
  assert.ok(f.played[0].options.volume < interfaceSoundCues.agentTyping.volume)
  assert.ok(f.played[0].options.volume < interfaceSoundCues.composerTyping.volume)
})
