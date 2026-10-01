import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createVoiceApis, voiceProvider } from '../src/voice-api.ts'

function exchange({ method = 'POST', origin = 'http://localhost:5173', extraHeaders = {} } = {}) {
  const req = Readable.from([])
  req.method = method
  req.headers = { host: 'localhost:5173', origin, ...extraHeaders }
  const res = new EventEmitter()
  res.setHeader = (name, value) => { res[name] = value }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = body => { res.body = JSON.parse(body); res.writableEnded = true }
  return { req, res }
}
async function run(handler, options) {
  const { req, res } = exchange(options)
  await handler(req, res)
  return res
}
function engine() {
  return { speech_engine_id: 'seng_test',
    speech_engine: { ws_url: 'wss://public.example/speech-engine/upstream', request_headers: { secret: 'private_header' } },
    tts: { model_id: 'eleven_v4_turbo', voice_id: 'voice_test' },
    conversation: { client_events: ['audio', 'user_transcript', 'agent_response'] },
  }
}
function api(fetcher, overrides = {}) {
  return createVoiceApis({ provider: 'elevenlabs', elevenlabsApiKey: 'server_secret',
    elevenlabsSpeechEngineId: 'seng_test', registerConversation: () => true, fetch: fetcher, ...overrides })
}

test('voice selection defaults to OpenAI and rejects unknown providers without fallback', () => {
  assert.equal(voiceProvider(undefined), 'openai')
  assert.equal(voiceProvider(''), 'openai')
  assert.equal(voiceProvider('openai'), 'openai')
  assert.equal(voiceProvider('elevenlabs'), 'elevenlabs')
  assert.throws(() => voiceProvider('scribe'), /must be openai or elevenlabs/)
})

test('provider discovery is local, no-store, and contains no credentials', async () => {
  const voice = api(() => { throw new Error('No upstream discovery call') })
  const res = await run(voice.provider, { method: 'GET', origin: undefined, extraHeaders: { origin: undefined, 'sec-fetch-site': 'same-origin' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { provider: 'elevenlabs' })
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal((await run(voice.provider, { method: 'GET', origin: 'https://evil.example' })).status, 403)
  assert.equal((await run(voice.provider)).status, 405)
})

test('preflight rejects missing or blank selected credentials before any upstream call', async () => {
  let calls = 0
  const fetcher = async () => { calls++; throw new Error('Unexpected upstream call') }
  for (const options of [
    { provider: 'openai' }, { provider: 'openai', openaiApiKey: '  ' },
    { provider: 'elevenlabs', elevenlabsSpeechEngineId: 'seng_test' },
    { provider: 'elevenlabs', elevenlabsApiKey: 'test-only' },
    { provider: 'elevenlabs', elevenlabsApiKey: '  ', elevenlabsSpeechEngineId: 'seng_test' },
  ]) {
    const res = await run(createVoiceApis({ ...options, fetch: fetcher }).provider, { method: 'GET' })
    assert.equal(res.status, 503)
    assert.match(res.body.error, /requires .* on the server/)
    assert.equal(res.headers['Cache-Control'], 'no-store')
  }
  const openai = await run(createVoiceApis({ provider: 'openai', openaiApiKey: 'test-only' }).provider, { method: 'GET' })
  assert.deepEqual(openai.body, { provider: 'openai' })
  assert.equal(calls, 0)
})

test('private token uses the validated Speech Engine and registers its conversation before exposing bootstrap fields', async () => {
  const calls = []
  const admissions = []
  const voice = api(async (url, init) => {
    calls.push({ url, init })
    return Response.json(calls.length === 1 ? engine() : { token: 'conversation_token', conversation_id: 'private_id', private: 'upstream_details' })
  }, { registerConversation: id => { admissions.push(id); return true } })
  const res = await run(voice.elevenlabsSession)
  assert.equal(res.status, 201)
  assert.deepEqual(res.body, { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'conversation_token' })
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(calls[0].url.pathname, '/v1/speech-engine/seng_test')
  assert.equal(calls[1].url.pathname, '/v1/convai/conversation/token')
  assert.equal(calls[1].url.searchParams.has('version_id'), false)
  assert.deepEqual(admissions, ['private_id'])
  assert.equal(calls[1].url.searchParams.get('agent_id'), 'seng_test')
  assert.equal(calls[1].init.headers['xi-api-key'], 'server_secret')
  assert.equal(calls[1].init.redirect, 'error')
  assert.ok(!JSON.stringify(res.body).includes('server_secret'))
})

test('wrong engine, model, missing voice or upstream and disabled audio fail before token issuance', async () => {
  const mutations = [
    value => { value.speech_engine_id = 'seng_other' },
    value => { value.tts.model_id = 'eleven_flash_v2' },
    value => { value.tts.supported_voices = [{ model_family: 'flash' }] },
    value => { delete value.tts.voice_id },
    value => { value.tts.voice_id = '  ' },
    value => { delete value.speech_engine },
    value => { value.speech_engine.ws_url = 'https://public.example' },
    value => { value.speech_engine.ws_url = 'wss://user:secret@public.example/ws' },
    value => { value.conversation.client_events = ['audio'] },
    value => { value.conversation.text_only = true },
  ]
  for (const mutate of mutations) {
    let calls = 0
    const value = engine(); mutate(value)
    const result = await run(api(async () => { calls++; return Response.json(value) }).elevenlabsSession)
    assert.equal(result.status, 503)
    assert.equal(calls, 1)
    assert.ok(!JSON.stringify(result.body).includes('private_header'))
  }
})

test('missing config, disabled provider, bad method and origin never request a token', async () => {
  let calls = 0
  const voice = api(async () => { calls++; throw new Error('Unexpected') })
  assert.equal((await run(voice.openaiSession)).status, 409)
  assert.equal((await run(voice.elevenlabsSession, { method: 'GET' })).status, 405)
  assert.equal((await run(voice.elevenlabsSession, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await run(api(undefined, { elevenlabsApiKey: undefined }).elevenlabsSession)).status, 503)
  assert.equal((await run(api(undefined, { elevenlabsSpeechEngineId: undefined }).elevenlabsSession)).status, 503)
  assert.equal((await run(api(undefined, { provider: 'openai' }).elevenlabsSession)).status, 409)
  assert.equal(calls, 0)
})

test('upstream auth/quota/model errors are safe and bounded responses are enforced', async () => {
  for (const [upstream, expected] of [[401, 503], [403, 503], [404, 503], [422, 503], [429, 429], [500, 502]]) {
    const res = await run(api(async () => Response.json({ details: 'private_secret' }, { status: upstream })).elevenlabsSession)
    assert.equal(res.status, expected)
    assert.ok(!JSON.stringify(res.body).includes('private_secret'))
  }
  for (const invalid of [new Response('invalid_json'), new Response('a'.repeat(1024 * 1024 + 1))]) {
    assert.equal((await run(api(async () => invalid).elevenlabsSession)).status, 502)
  }
  let calls = 0
  const res = await run(api(async () => Response.json(++calls === 1 ? engine() : { token: '' })).elevenlabsSession)
  assert.equal(res.status, 502)
})

test('client disconnect aborts upstream and leaves no token response or listener', async () => {
  const { req, res } = exchange()
  let signal
  const voice = api(async (_url, init) => {
    signal = init.signal
    res.emit('close')
    throw new Error('Aborted')
  })
  await voice.elevenlabsSession(req, res)
  assert.equal(signal.aborted, true)
  assert.equal(res.body, undefined)
  assert.equal(res.listenerCount('close'), 0)
})

test('timeout aborts upstream and returns a recoverable error', async () => {
  let signal
  const res = await run(api(async (_url, init) => {
    signal = init.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }))
  }, { timeoutMs: 5 }).elevenlabsSession)
  assert.equal(signal.aborted, true)
  assert.equal(res.status, 504)
  assert.equal(res.listenerCount('close'), 0)
})


test('Speech Engine needs no hosted agent LLM, workflow, version or interruption configuration', async () => {
  let calls = 0
  const result = await run(api(async () => Response.json(++calls === 1 ? engine()
    : { token: 'token', conversation_id: 'conv_test' })).elevenlabsSession)
  assert.equal(result.status, 201)
  assert.equal(calls, 2)
})

test('missing admission and hosted agent IDs fail closed before upstream calls', async () => {
  let calls = 0
  for (const options of [{ registerConversation: undefined }, { elevenlabsSpeechEngineId: 'agent_test' }]) {
    const voice = api(async () => { calls++; throw new Error('Unexpected') }, options)
    assert.equal((await run(voice.provider, { method: 'GET' })).status, 503)
    assert.equal((await run(voice.elevenlabsSession)).status, 503)
  }
  assert.equal(calls, 0)
})

test('invalid token or conversation IDs never register and admission rejection never exposes token', async () => {
  for (const result of [{ token: '' }, { token: 'token' }, { token: 'token', conversation_id: '' },
    { token: 'token', conversation_id: 'invalid\nID' }, { token: 'token', conversation_id: 'x'.repeat(257) },
    { token: 'x'.repeat(32769), conversation_id: 'conv_test' }]) {
    let calls = 0
    let registered = false
    const res = await run(api(async () => Response.json(++calls === 1 ? engine() : result),
      { registerConversation: () => { registered = true; return true } }).elevenlabsSession)
    assert.equal(res.status, 502)
    assert.equal(registered, false)
  }
  for (const registerConversation of [() => false, () => { throw new Error('private_secret') }]) {
    let calls = 0
    const res = await run(api(async () => Response.json(++calls === 1 ? engine()
      : { token: 'private_token', conversation_id: 'conv_test' }), { registerConversation }).elevenlabsSession)
    assert.ok([502, 503].includes(res.status))
    assert.ok(!JSON.stringify(res.body).includes('private_'))
  }
})

test('a disconnected token fetch cannot register or expose a late conversation', async () => {
  const { req, res } = exchange()
  let calls = 0
  let registered = false
  const voice = api(async () => {
    if (++calls === 1) return Response.json(engine())
    res.emit('close')
    return Response.json({ token: 'token', conversation_id: 'conv_late' })
  }, { registerConversation: () => { registered = true; return true } })
  await voice.elevenlabsSession(req, res)
  assert.equal(registered, false)
  assert.equal(res.body, undefined)
})
