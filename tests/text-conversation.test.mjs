import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextConversationStore } from '../src/lib/text-conversation.ts'
import { TextChatError } from '../src/lib/text-chat-client.ts'
import { createPacingClock } from './helpers/pacing-clock.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const clock = createPacingClock()
  const attempts = []
  let nextId = 0
  const store = createTextConversationStore((messages, signal, onDelta) => {
    const result = deferred()
    attempts.push({ messages, signal, onDelta, ...result })
    return result.promise
  }, () => `turn-${++nextId}`, clock.schedule, clock.now)
  return { attempts, store, clock }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('fresh store starts in text; whitespace and overlapping sends are rejected', async () => {
  const { store, attempts, clock } = setup()
  assert.equal(store.getState().mode, 'text')
  assert.deepEqual(store.getState().turns, [])
  store.getState().enterText()
  assert.equal(store.getState().sendText(' \n '), null)
  const id = store.getState().sendText('  hello  ')
  assert.equal(id, 'turn-1')
  assert.equal(store.getState().sendText('other'), null)
  assert.deepEqual(attempts[0].messages, [{ role: 'user', content: '  hello  ' }])
  assert.equal(store.getState().turns[0].status, 'waiting')
  attempts[0].onDelta('')
  clock.advance()
  assert.equal(store.getState().turns[0].status, 'waiting')
  attempts[0].onDelta('Hi')
  clock.advance()
  assert.equal(store.getState().turns[0].status, 'streaming')
  attempts[0].onDelta(' there')
  clock.advance()
  assert.equal(store.getState().turns[0].assistantText, 'Hi there')
  attempts[0].resolve()
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[0].status, 'complete')
  assert.equal(store.getState().activeTurnId, null)
})

test('context uses completed pairs in order and omits failed partial turns', async () => {
  const { store, attempts, clock } = setup()
  store.getState().enterText()
  store.getState().sendText('first')
  attempts[0].onDelta('answer one')
  clock.advance()
  attempts[0].resolve()
  await tick()
  clock.flush()
  store.getState().sendText('second')
  assert.deepEqual(attempts[1].messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'second' },
  ])
  attempts[1].onDelta('partial')
  clock.advance()
  attempts[1].reject(new TextChatError('Stream failed.', 'upstream_error'))
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[1].status, 'failed')
  assert.equal(store.getState().turns[1].assistantText, 'partial')
  assert.equal(store.getState().turns[1].error, 'Stream failed.')
  store.getState().sendText('third')
  assert.deepEqual(attempts[2].messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'third' },
  ])
  assert.equal(store.getState().retryTurn('turn-2'), false)
})

test('retry reuses the latest failed turn and replaces its partial reply', async () => {
  const { store, attempts, clock } = setup()
  store.getState().enterText()
  const id = store.getState().sendText('question')
  attempts[0].onDelta('partial')
  clock.advance()
  attempts[0].reject(new Error('private detail'))
  await tick()
  clock.flush()
  assert.match(store.getState().turns[0].error, /Could not complete/)
  assert.equal(store.getState().retryTurn('other'), false)
  assert.equal(store.getState().retryTurn(id), true)
  assert.equal(store.getState().retryTurn(id), false)
  assert.equal(store.getState().turns.length, 1)
  assert.equal(store.getState().turns[0].id, id)
  assert.equal(store.getState().turns[0].assistantText, '')
  assert.equal(store.getState().turns[0].error, null)
  assert.deepEqual(attempts[1].messages, [{ role: 'user', content: 'question' }])
  attempts[1].onDelta('full reply')
  clock.advance()
  attempts[1].resolve()
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[0].status, 'complete')
})

test('mode switch cancels, preserves transcript, and ignores stale delta and completion', async () => {
  const { store, attempts, clock } = setup()
  store.getState().enterText()
  store.getState().sendText('old')
  attempts[0].onDelta('partial')
  clock.advance()
  store.getState().enterVoice()
  assert.equal(attempts[0].signal.aborted, true)
  assert.equal(store.getState().mode, 'voice')
  assert.equal(store.getState().activeTurnId, null)
  assert.equal(store.getState().turns[0].status, 'failed')
  assert.equal(store.getState().turns[0].assistantText, 'partial')
  store.getState().cancelActive()
  store.getState().enterText()
  store.getState().sendText('new')
  attempts[0].onDelta('stale')
  clock.advance()
  attempts[0].resolve()
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[0].assistantText, 'partial')
  assert.equal(store.getState().activeTurnId, 'turn-2')
  attempts[1].onDelta('current')
  clock.advance()
  attempts[1].resolve()
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[1].assistantText, 'current')
  assert.equal(store.getState().turns[1].status, 'complete')
  assert.deepEqual(createTextConversationStore().getState().turns, [])
})

test('cancelActive aborts a pending request and stale failure cannot replace a later attempt', async () => {
  const { store, attempts, clock } = setup()
  store.getState().enterText()
  store.getState().sendText('one')
  store.getState().cancelActive()
  store.getState().cancelActive()
  store.getState().sendText('two')
  attempts[0].reject(new Error('aborted'))
  await tick()
  clock.flush()
  assert.equal(store.getState().activeTurnId, 'turn-2')
  assert.equal(store.getState().turns[0].error, 'Reply canceled.')
  assert.equal(store.getState().turns[1].status, 'waiting')
})

test('the turn remains active after network completion until all queued text is displayed', async () => {
  const { store, attempts, clock } = setup()
  const id = store.getState().sendText('question')
  const source = 'one two three '.repeat(100)
  attempts[0].onDelta(source)
  attempts[0].resolve()
  await tick()
  assert.equal(store.getState().turns[0].assistantText, '')
  assert.equal(store.getState().activeTurnId, id)
  assert.equal(store.getState().sendText('too early'), null)
  clock.advance()
  assert.ok(store.getState().turns[0].assistantText.length > 0)
  assert.ok(store.getState().turns[0].assistantText.length < source.length)
  assert.equal(store.getState().turns[0].status, 'streaming')
  assert.equal(store.getState().activeTurnId, id)
  attempts[0].onDelta('ignored after transport completion')
  clock.flush()
  assert.equal(store.getState().turns[0].assistantText, source)
  assert.equal(store.getState().turns[0].status, 'complete')
  assert.equal(store.getState().activeTurnId, null)
})

test('cancel during post-network display stops the queue and retry cannot inherit old text', async () => {
  const { store, attempts, clock } = setup()
  const id = store.getState().sendText('question')
  const source = 'one two three '.repeat(100)
  attempts[0].onDelta(source)
  attempts[0].resolve()
  await tick()
  clock.advance()
  store.getState().cancelActive()
  assert.equal(clock.pending, 0)
  assert.ok(store.getState().turns[0].assistantText.length > 0)
  assert.ok(store.getState().turns[0].assistantText.length < source.length)
  assert.equal(store.getState().retryTurn(id), true)
  attempts[1].onDelta('new reply')
  attempts[1].resolve()
  await tick()
  clock.flush()
  assert.equal(store.getState().turns[0].assistantText, 'new reply')
  assert.equal(store.getState().turns[0].status, 'complete')
})

test('real failures drain received text before exposing the retry state', async () => {
  const { store, attempts, clock } = setup()
  const id = store.getState().sendText('question')
  attempts[0].onDelta('partial answer')
  attempts[0].reject(new TextChatError('Stream failed.', 'upstream_error'))
  await tick()
  assert.equal(store.getState().activeTurnId, id)
  assert.equal(store.getState().retryTurn(id), false)
  clock.flush()
  assert.equal(store.getState().turns[0].assistantText, 'partial answer')
  assert.equal(store.getState().turns[0].status, 'failed')
  assert.equal(store.getState().turns[0].error, 'Stream failed.')
  assert.equal(store.getState().activeTurnId, null)
})
