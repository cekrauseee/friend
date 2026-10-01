import assert from 'node:assert/strict'
import { test } from 'node:test'
import OpenAI from 'openai'
import { ChatError, createApiChatProvider } from '../server/conversation-provider.ts'
import { ChatError as HttpChatError } from '../server/chat-api.ts'
import { conversationConfig, conversationInstructions } from '../server/conversation-config.ts'
import { sessionConfig } from '../server/session-config.ts'

const history = [
  { role: 'user', content: 'Remember this' },
  { role: 'assistant', content: 'I will' },
  { role: 'user', content: 'What did I say?' },
]
const controller = () => new AbortController()
const complete = { type: 'response.completed', response: { status: 'completed' } }
function client(events, capture = () => {}) {
  return { responses: { create: async (settings, options) => {
    capture(settings, options)
    return (async function* () {
      for (const event of events) {
        if (event instanceof Error) throw event
        yield event
      }
    })()
  } } }
}

test('direct speech and text consumers receive the full history and canonical configuration', async () => {
  let settings
  let signal
  const abort = controller()
  const provider = createApiChatProvider(undefined, client([
    { type: 'response.output_text.delta', delta: 'Remember this' }, complete,
    { type: 'response.output_text.delta', delta: 'ignored' },
  ], (s, options) => { settings = s; signal = options.signal }))
  assert.deepEqual(await Array.fromAsync(provider(history, abort.signal)), [
    { type: 'delta', text: 'Remember this' }, { type: 'done' },
  ])
  assert.deepEqual(settings, { ...conversationConfig, input: history, stream: true, store: false })
  assert.equal(signal, abort.signal)
  assert.equal(settings.instructions, conversationInstructions)
  assert.deepEqual(sessionConfig.delegation.responses, conversationConfig)
  assert.equal(HttpChatError, ChatError)
})

test('provider streams remain independent between conversations and turns', async () => {
  const inputs = []
  const provider = createApiChatProvider(undefined, client([
    { type: 'response.output_text.delta', delta: 'Reply' }, complete,
  ], (settings) => inputs.push(settings.input)))
  const other = [{ role: 'user', content: 'Other conversation' }]
  await Promise.all([Array.fromAsync(provider(history, controller().signal)), Array.fromAsync(provider(other, controller().signal))])
  assert.deepEqual(inputs, [history, other])
})

test('provider fails safely before stream startup without credentials or on API failure', async () => {
  await assert.rejects(Array.fromAsync(createApiChatProvider(undefined)(history, controller().signal)), { code: 'not_configured' })
  const failure = OpenAI.APIError.generate(401, { error: { message: 'private credential' } }, 'private credential', new Headers())
  const provider = createApiChatProvider(undefined, { responses: { create: async () => { throw failure } } })
  await assert.rejects(Array.fromAsync(provider(history, controller().signal)), (error) => {
    assert.equal(error.code, 'access_denied')
    assert.ok(!error.message.includes('private'))
    return true
  })
})

test('direct provider requires nonempty completed output and emits one safe terminal error', async () => {
  for (const events of [[], [complete], [{ type: 'response.output_text.delta', delta: 'Partial' }],
    [{ type: 'response.output_text.delta', delta: 'Partial' }, new Error('private details')]]) {
    const result = await Array.fromAsync(createApiChatProvider(undefined, client(events))(history, controller().signal))
    assert.equal(result.at(-1).type, 'error')
    assert.equal(result.filter((event) => event.type !== 'delta').length, 1)
    assert.ok(!JSON.stringify(result).includes('private'))
  }
})

test('already aborted and cancelled direct consumers receive no late terminal events', async () => {
  let calls = 0
  const upstream = client([{ type: 'response.output_text.delta', delta: 'First' }, complete], () => { calls++ })
  const provider = createApiChatProvider(undefined, upstream)
  const pre = controller(); pre.abort()
  assert.deepEqual(await Array.fromAsync(provider(history, pre.signal)), [])
  assert.equal(calls, 0)
  const abort = controller()
  const result = []
  for await (const event of provider(history, abort.signal)) {
    result.push(event)
    abort.abort()
  }
  assert.deepEqual(result, [{ type: 'delta', text: 'First' }])
})
