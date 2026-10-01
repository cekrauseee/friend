import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createVoiceApis, voiceProvider } from '../server/voice-api.ts'

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
function agent() {
  return { agent_id: 'agent_test', version_id: 'version_test', conversation_config: {
    tts: { model_id: 'eleven_v4_turbo' }, agent: { prompt: { llm: 'gemini-3.8-flash' } },
    conversation: { client_events: ['user_transcript', 'agent_response', 'agent_response_correction', 'interruption'] },
  } }
}
function api(fetcher, overrides = {}) {
  return createVoiceApis({ provider: 'elevenlabs', elevenlabsApiKey: 'server_secret', elevenlabsAgentId: 'agent_test', fetch: fetcher, ...overrides })
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

test('private token pins the validated v4 Turbo version and exposes only the bootstrap fields', async () => {
  const calls = []
  const voice = api(async (url, init) => {
    calls.push({ url, init })
    return Response.json(calls.length === 1 ? agent() : { token: 'conversation_token', conversation_id: 'private_id', private: 'upstream_details' })
  })
  const res = await run(voice.elevenlabsSession)
  assert.equal(res.status, 201)
  assert.deepEqual(res.body, { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'conversation_token' })
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(calls[0].url.pathname, '/v1/convai/agents/agent_test')
  assert.equal(calls[1].url.pathname, '/v1/convai/conversation/token')
  assert.equal(calls[1].url.searchParams.get('version_id'), 'version_test')
  assert.equal(calls[1].url.searchParams.get('agent_id'), 'agent_test')
  assert.equal(calls[1].init.headers['xi-api-key'], 'server_secret')
  assert.equal(calls[1].init.redirect, 'error')
  assert.ok(!JSON.stringify(res.body).includes('server_secret'))
})

test('wrong engine, custom LLM, missing version, disabled interruptions and alternate workflow are configuration errors before token', async () => {
  const mutations = [
    value => { value.conversation_config.tts.model_id = 'eleven_v3_conversational' },
    value => { value.conversation_config.tts.supported_voices = [{ model_family: 'flash' }] },
    value => { value.conversation_config.agent.prompt.llm = 'custom-llm' },
    value => { value.conversation_config.agent.prompt.custom_llm = { url: 'https://private.example' } },
    value => { delete value.version_id },
    value => { value.conversation_config.agent.disable_first_message_interruptions = true },
    value => { value.conversation_config.conversation.client_events = ['audio'] },
    value => { value.conversation_config.conversation.text_only = true },
    value => { value.workflow = { nodes: { transfer: {} } } },
    value => { value.conversation_config.language_presets = { fr: { overrides: { tts: { model_id: 'eleven_flash_v2' } } } } },
  ]
  for (const mutate of mutations) {
    let calls = 0
    const value = agent(); mutate(value)
    const result = await run(api(async () => { calls++; return Response.json(value) }).elevenlabsSession)
    assert.equal(result.status, 503)
    assert.equal(calls, 1)
  }
})

test('missing config, disabled provider, bad method and origin never request a token', async () => {
  let calls = 0
  const voice = api(async () => { calls++; throw new Error('Unexpected') })
  assert.equal((await run(voice.openaiSession)).status, 409)
  assert.equal((await run(voice.elevenlabsSession, { method: 'GET' })).status, 405)
  assert.equal((await run(voice.elevenlabsSession, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await run(api(undefined, { elevenlabsApiKey: undefined }).elevenlabsSession)).status, 503)
  assert.equal((await run(api(undefined, { elevenlabsAgentId: undefined }).elevenlabsSession)).status, 503)
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
  const res = await run(api(async () => Response.json(++calls === 1 ? agent() : { token: '' })).elevenlabsSession)
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


test('ordinary multilingual presets preserve the validated engine and native LLM', async () => {
  const value = agent()
  value.conversation_config.language_presets = {
    fr: { overrides: { agent: { language: 'fr', first_message: 'Bonjour' } } },
    es: { overrides: { tts: { model_id: 'eleven_v4_turbo' }, agent: { prompt: { llm: 'gpt-6-luna' } } } },
  }
  let calls = 0
  const result = await run(api(async () => Response.json(++calls === 1 ? value : { token: 'token' })).elevenlabsSession)
  assert.equal(result.status, 201)
  assert.equal(calls, 2)
})
