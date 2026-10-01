import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request } from 'node:http'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { createApp } from '../src/app.ts'
import { createChatApi } from '../src/chat-api.ts'
import { createTextAccessApi } from '../src/codex-provider.ts'
import { createLiveApi } from '../src/live-api.ts'
import { createVoiceApis } from '../src/voice-api.ts'
import { createProviderTranscriptionApi } from '../src/transcription-api.ts'

const origin = 'http://localhost:5173'
const ok = (_req, res) => { res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end('ok') }
async function fixture(t, overrides = {}, options = {}) {
  const handlers = { chat: ok, textAccess: createTextAccessApi(), voiceProvider: ok,
    openaiSession: ok, elevenlabsSession: ok, transcription: ok, ...overrides }
  const app = createApp(handlers, { frontendOrigins: [origin, 'https://app.example'], mode: 'development', ...options })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}
function call(base, path, { method = 'POST', headers = {}, body } = {}) {
  return fetch(base + path, { method, headers: { Origin: origin, ...headers }, body })
}

test('configured origins, CORS preflight, missing-Origin discovery and rejection', async t => {
  const base = await fixture(t)
  let res = await call(base, '/api/chat', { headers: { Origin: 'https://app.example' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example')
  res = await call(base, '/api/chat', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST')
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type')
  for (const badOrigin of ['null', '*', 'https://evil.example', origin + '/', 'http://localhost:5174']) {
    res = await call(base, '/api/chat', { headers: { Origin: badOrigin, 'X-Forwarded-Host': 'localhost:5173' } })
    assert.equal(res.status, 403)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  }
  for (const headers of [{ 'Access-Control-Request-Method': 'DELETE' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }]) {
    assert.equal((await call(base, '/api/chat', { method: 'OPTIONS', headers })).status, 403)
  }
  assert.equal((await fetch(base + '/api/voice-provider', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200)
  assert.equal((await fetch(base + '/api/voice-provider')).status, 403)
  assert.equal((await fetch(base + '/api/voice-provider', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403)
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ready: true })
  res = await call(base, '/api/session', { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})

test('text access receives stripped suffixes and local login stays restricted', async t => {
  const seen = []
  const access = createTextAccessApi({ status: async () => ({ provider: 'codex', authenticated: false, login: null }),
    startLogin: async () => ({ loginId: 'id', authUrl: 'https://auth.openai.com/' }), cancelLogin: async () => {} })
  const base = await fixture(t, { textAccess: (req, res) => { seen.push(req.url); return access(req, res) } })
  for (const action of ['status', 'login', 'cancel']) assert.equal((await call(base, `/api/text-access/${action}?ignored=true`)).status, 200)
  assert.deepEqual(seen, ['/status', '/login', '/cancel'])
  assert.equal((await call(base, '/api/text-access/login', { headers: { Origin: 'https://app.example' } })).status, 403)
  const production = await fixture(t, {}, { mode: 'production' })
  assert.equal((await call(production, '/api/text-access/login')).status, 403)
  assert.equal((await call(production, '/api/text-access/status')).status, 200)
})

test('real chat sends a delta before completion and aborts on disconnect', async t => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  let aborted
  const abortedPromise = new Promise(resolve => { aborted = resolve })
  const handler = createChatApi(undefined, undefined, async function* (_messages, signal) {
    signal.addEventListener('abort', aborted, { once: true })
    yield { type: 'delta', text: 'first' }
    await gate
    yield { type: 'done' }
  })
  const base = await fixture(t, { chat: handler })
  const req = request(base + '/api/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } })
  req.end(JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }))
  const [res] = await once(req, 'response')
  const [chunk] = await once(res, 'data')
  assert.deepEqual(JSON.parse(chunk.toString()), { type: 'delta', text: 'first' })
  res.destroy()
  await abortedPromise
  finish()
})

test('raw audio remains intact, bounded, and session framing stays unchanged', async t => {
  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3])
  let captured
  const transcription = createProviderTranscriptionApi({ transcribe: async input => { captured = input.audio; return 'words' } }, 'unavailable')
  const live = createLiveApi(undefined, { live: { create: async input => {
    assert.equal(input.transport.sdp, 'v=0\r\no=browser')
    return { session: { id: 'session' }, transport: { sdp: 'v=0\r\no=server' } }
  } } })
  const base = await fixture(t, { transcription, openaiSession: live })
  let res = await call(base, '/api/transcription', { headers: { 'Content-Type': 'audio/webm' }, body: audio })
  assert.deepEqual(await res.json(), { text: 'words' })
  assert.deepEqual(captured, audio)
  res = await call(base, '/api/session', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0\r\no=browser' }) })
  assert.equal(res.status, 201)
  assert.deepEqual(await res.json(), { session: { id: 'session' }, transport: { type: 'webrtc', sdp: 'v=0\r\no=server' } })
  const req = request(base + '/api/transcription', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/webm', 'Content-Length': '25000001' } })
  req.flushHeaders()
  const [response] = await once(req, 'response')
  assert.equal(response.statusCode, 413)
  response.resume(); req.destroy()
})

test('adapter returns a safe error before headers and closes partial failures', async t => {
  const base = await fixture(t, { chat: () => { throw new Error('secret') },
    elevenlabsSession: (_req, res) => { res.writeHead(200); res.write('partial'); throw new Error('secret') } })
  const res = await call(base, '/api/chat')
  assert.equal(res.status, 500)
  assert.equal((await res.text()).includes('secret'), false)
  await assert.rejects(async () => { const response = await call(base, '/api/elevenlabs-session'); await response.text() })
})

test('invalid origin configurations fail closed', () => {
  for (const frontendOrigins of [[], ['*'], ['null'], ['http://localhost:5173/'], ['http://user:pass@localhost:5173'], ['http://*.example']]) {
    assert.throws(() => createApp({}, { frontendOrigins, mode: 'development' }))
  }
})

test('mounted chat waits for Node drain before requesting the next provider event', async t => {
  let waitingForDrain = false
  let backpressureCount = 0
  const chat = createChatApi(undefined, undefined, async function* () {
    for (let index = 0; index < 8; index++) {
      assert.equal(waitingForDrain, false, 'provider advanced while outgoing awaited drain')
      yield { type: 'delta', text: 'x'.repeat(256 * 1024) }
    }
    assert.equal(waitingForDrain, false)
    yield { type: 'done' }
  })
  const base = await fixture(t, { chat: (req, res) => {
    const write = res.write.bind(res)
    res.write = (...args) => {
      const ready = write(...args)
      if (!ready) {
        waitingForDrain = true
        backpressureCount++
        res.once('drain', () => { waitingForDrain = false })
      }
      return ready
    }
    return chat(req, res)
  } })
  const response = await call(base, '/api/chat', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
  })
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.length, 9)
  assert.deepEqual(events.at(-1), { type: 'done' })
  assert.ok(backpressureCount > 0, 'real Node writes must exercise backpressure')
})


test('ElevenLabs route preserves private token framing and admission order', async t => {
  let admitted = false
  const voice = createVoiceApis({ provider: 'elevenlabs', elevenlabsApiKey: 'synthetic',
    elevenlabsSpeechEngineId: 'seng_test', registerConversation: id => {
      assert.equal(id, 'conversation'); admitted = true; return true
    }, fetch: async url => Response.json(url.pathname.includes('/speech-engine/') ? {
      speech_engine_id: 'seng_test', tts: { model_id: 'eleven_v4_turbo', voice_id: 'voice' },
      speech_engine: { ws_url: 'wss://upstream.example/path' },
      conversation: { client_events: ['audio', 'user_transcript', 'agent_response'] },
    } : { token: 'private-token', conversation_id: 'conversation' }) })
  const base = await fixture(t, { elevenlabsSession: voice.elevenlabsSession })
  const res = await call(base, '/api/elevenlabs-session')
  assert.equal(res.status, 201)
  assert.equal(admitted, true)
  assert.deepEqual(await res.json(), { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'private-token' })
  assert.equal(res.headers.get('cache-control'), 'no-store')
})
