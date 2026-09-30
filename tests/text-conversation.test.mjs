import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextConversationStore } from '../src/lib/text-conversation.ts'
import { TextChatError } from '../src/lib/text-chat-client.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  const attempts = []
  let nextId = 0
  const store = createTextConversationStore((messages, signal, onDelta) => {
    const result = deferred()
    attempts.push({ messages, signal, onDelta, ...result })
    return result.promise
  }, () => `turn-${++nextId}`)
  return { attempts, store }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('fresh store starts in voice; whitespace and overlapping sends are rejected', async () => {
  const { store, attempts } = setup()
  assert.equal(store.getState().mode, 'voice')
  assert.deepEqual(store.getState().turns, [])
  assert.equal(store.getState().sendText('hello'), null)
  store.getState().enterText()
  assert.equal(store.getState().sendText(' \n '), null)
  const id = store.getState().sendText('  hello  ')
  assert.equal(id, 'turn-1')
  assert.equal(store.getState().sendText('other'), null)
  assert.deepEqual(attempts[0].messages, [{ role: 'user', content: '  hello  ' }])
  assert.equal(store.getState().turns[0].status, 'waiting')
  attempts[0].onDelta('')
  assert.equal(store.getState().turns[0].status, 'waiting')
  attempts[0].onDelta('Hi')
  assert.equal(store.getState().turns[0].status, 'streaming')
  attempts[0].onDelta(' there')
  assert.equal(store.getState().turns[0].assistantText, 'Hi there')
  attempts[0].resolve()
  await tick()
  assert.equal(store.getState().turns[0].status, 'complete')
  assert.equal(store.getState().activeTurnId, null)
})

test('context uses completed pairs in order and omits failed partial turns', async () => {
  const { store, attempts } = setup()
  store.getState().enterText()
  store.getState().sendText('first')
  attempts[0].onDelta('answer one')
  attempts[0].resolve()
  await tick()
  store.getState().sendText('second')
  assert.deepEqual(attempts[1].messages, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'second' },
  ])
  attempts[1].onDelta('partial')
  attempts[1].reject(new TextChatError('Stream failed.', 'upstream_error'))
  await tick()
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
  const { store, attempts } = setup()
  store.getState().enterText()
  const id = store.getState().sendText('question')
  attempts[0].onDelta('partial')
  attempts[0].reject(new Error('private detail'))
  await tick()
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
  attempts[1].resolve()
  await tick()
  assert.equal(store.getState().turns[0].status, 'complete')
})

test('mode switch cancels, preserves transcript, and ignores stale delta and completion', async () => {
  const { store, attempts } = setup()
  store.getState().enterText()
  store.getState().sendText('old')
  attempts[0].onDelta('partial')
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
  attempts[0].resolve()
  await tick()
  assert.equal(store.getState().turns[0].assistantText, 'partial')
  assert.equal(store.getState().activeTurnId, 'turn-2')
  attempts[1].onDelta('current')
  attempts[1].resolve()
  await tick()
  assert.equal(store.getState().turns[1].assistantText, 'current')
  assert.equal(store.getState().turns[1].status, 'complete')
  assert.deepEqual(createTextConversationStore().getState().turns, [])
})

test('cancelActive aborts a pending request and stale failure cannot replace a later attempt', async () => {
  const { store, attempts } = setup()
  store.getState().enterText()
  store.getState().sendText('one')
  store.getState().cancelActive()
  store.getState().cancelActive()
  store.getState().sendText('two')
  attempts[0].reject(new Error('aborted'))
  await tick()
  assert.equal(store.getState().activeTurnId, 'turn-2')
  assert.equal(store.getState().turns[0].error, 'Reply canceled.')
  assert.equal(store.getState().turns[1].status, 'waiting')
})
