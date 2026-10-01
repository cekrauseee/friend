import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { liveApiPlugin } from '../server/vite-plugin.ts'
import { conversationConfig } from '../server/conversation-config.ts'
import { createSpeechEngineServer, speechEngineAddress } from '../server/speech-engine-server.ts'
import { createSpeechEngineAdmission } from '../server/speech-engine-admission.ts'

const key = 'local-test-key'
function jwt() {
  const encoded = [{ alg: 'HS256' }, {
    iss: 'https://api.elevenlabs.io/convai/speech-engine', sub: 'convai_speech_engine_upstream',
    exp: Date.now() / 1000 + 60,
  }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${encoded}.${createHmac('sha256', createHash('sha256').update(key).digest()).update(encoded).digest('base64url')}`
}
async function listen(server, port = 0) {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
async function unusedPort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}
function messages(socket) {
  const queue = []
  let wake
  socket.on('message', bytes => { queue.push(JSON.parse(bytes)); wake?.(); wake = undefined })
  return async () => {
    if (!queue.length) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Upstream response deadline')), 2000)
      wake = () => { clearTimeout(timer); resolve() }
    })
    return queue.shift()
  }
}

test('listener config is explicit and OpenAI does not depend on Speech Engine binding', async () => {
  assert.deepEqual(speechEngineAddress(), { host: '127.0.0.1', port: 3001 })
  for (const port of ['', '0', '65536', '3.5', '3001x']) assert.throws(() => speechEngineAddress(undefined, port), /PORT/)
  assert.throws(() => speechEngineAddress(''), /HOST/)
  const saved = process.env.DOT_VOICE_PROVIDER
  const savedPort = process.env.DOT_SPEECH_ENGINE_PORT
  const savedText = process.env.DOT_TEXT_PROVIDER
  const envDir = await mkdtemp(join(tmpdir(), 'dot-openai-runtime-'))
  try {
    process.env.DOT_VOICE_PROVIDER = 'openai'
    process.env.DOT_TEXT_PROVIDER = 'api'
    process.env.DOT_SPEECH_ENGINE_PORT = 'invalid'
    const plugin = liveApiPlugin()
    plugin.config({}, { command: 'serve', mode: 'production', isPreview: true })
    plugin.configResolved({ command: 'serve', mode: 'production', envDir })
    await plugin.closeBundle()
  } finally {
    for (const [name, value] of [['DOT_VOICE_PROVIDER', saved], ['DOT_SPEECH_ENGINE_PORT', savedPort], ['DOT_TEXT_PROVIDER', savedText]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    await rm(envDir, { recursive: true, force: true })
  }
})

test('binding failure is actionable, closes the bridge and permits idempotent cleanup', async t => {
  const occupied = createServer()
  const port = await listen(occupied)
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  const runtime = createSpeechEngineServer({ apiKey: key, provider: async function* () {}, admission: createSpeechEngineAdmission(), port })
  await assert.rejects(runtime.listen(), /port is in use.*DOT_SPEECH_ENGINE_PORT/)
  assert.equal(runtime.server.listenerCount('upgrade'), 0)
  await runtime.close()
  await runtime.close()
})

for (const preview of [false, true]) test(`${preview ? 'preview' : 'development'} wiring shares API cognition across text and successive admitted speech turns`, async t => {
  const names = ['DOT_VOICE_PROVIDER', 'DOT_TEXT_PROVIDER', 'DOT_TRANSCRIPTION_PROVIDER', 'DOT_SPEECH_ENGINE_HOST',
    'DOT_SPEECH_ENGINE_PORT', 'ELEVENLABS_API_KEY', 'ELEVENLABS_SPEECH_ENGINE_ID', 'OPENAI_API_KEY']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const nativeFetch = globalThis.fetch
  const envDir = await mkdtemp(join(tmpdir(), 'dot-speech-runtime-'))
  const port = await unusedPort()
  const routes = new Map()
  const app = createServer((req, res) => {
    const handler = routes.get(req.url)
    if (handler) void handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  const plugin = liveApiPlugin()
  let socket
  t.after(async () => {
    socket?.terminate()
    await plugin.closeBundle()
    if (app.listening) await new Promise(resolve => app.close(resolve))
    globalThis.fetch = nativeFetch
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]
    }
    await rm(envDir, { recursive: true, force: true })
  })
  for (const name of names) delete process.env[name]
  Object.assign(process.env, { DOT_VOICE_PROVIDER: 'elevenlabs', DOT_TEXT_PROVIDER: 'api',
    DOT_SPEECH_ENGINE_HOST: '127.0.0.1', DOT_SPEECH_ENGINE_PORT: `${port}`,
    ELEVENLABS_API_KEY: key, ELEVENLABS_SPEECH_ENGINE_ID: 'seng_test', OPENAI_API_KEY: 'test-only' })
  const inferences = []
  globalThis.fetch = async (url, init) => {
    const address = url.toString()
    if (address === 'https://api.elevenlabs.io/v1/speech-engine/seng_test') return Response.json({
      speech_engine_id: 'seng_test', speech_engine: { ws_url: 'wss://public.example/speech-engine/upstream' },
      tts: { model_id: 'eleven_v4_turbo', voice_id: 'voice_test' },
      conversation: { client_events: ['audio', 'user_transcript', 'agent_response'] },
    })
    if (address.startsWith('https://api.elevenlabs.io/v1/convai/conversation/token?')) {
      assert.equal(new URL(address).searchParams.get('agent_id'), 'seng_test')
      return Response.json({ token: 'short-lived-token', conversation_id: 'conv_runtime' })
    }
    if (address === 'https://api.openai.com/v1/responses') {
      inferences.push(JSON.parse(init.body))
      return new Response([
        { type: 'response.output_text.delta', delta: 'Shared ' },
        { type: 'response.output_text.delta', delta: 'reply' },
        { type: 'response.completed', response: { status: 'completed' } },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return nativeFetch(url, init)
  }
  const mode = preview ? 'production' : 'development'
  plugin.config({}, { command: 'serve', mode, isPreview: preview })
  plugin.configResolved({ command: 'serve', mode, envDir })
  await plugin[preview ? 'configurePreviewServer' : 'configureServer']({ httpServer: app,
    middlewares: { use: (path, handler) => routes.set(path, handler) } })
  const appPort = await listen(app)
  const appUrl = `http://127.0.0.1:${appPort}`
  const headers = { origin: appUrl, 'content-type': 'application/json' }
  const textHistory = [{ role: 'user', content: 'Text only' }]
  const text = await nativeFetch(`${appUrl}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ messages: textHistory }) })
  assert.equal(text.status, 200)
  assert.match(await text.text(), /Shared /)
  const token = await nativeFetch(`${appUrl}/api/elevenlabs-session`, { method: 'POST', headers })
  assert.equal(token.status, 201)
  assert.deepEqual(await token.json(), { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'short-lived-token' })
  for (const path of ['/', '/api/text-access', '/api/chat', '/api/elevenlabs-session']) {
    assert.equal((await nativeFetch(`http://127.0.0.1:${port}${path}`)).status, 404)
  }
  socket = new WebSocket(`ws://127.0.0.1:${port}/speech-engine/upstream`, { headers: { 'X-Elevenlabs-Speech-Engine-Authorization': jwt() } })
  const next = messages(socket)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'init', conversation_id: 'conv_runtime' }))
  const first = [{ role: 'user', content: 'Voice first' }]
  socket.send(JSON.stringify({ type: 'user_transcript', event_id: 1, user_transcript: first }))
  for (const [content, final] of [['Shared ', false], ['reply', false], ['', true]]) {
    assert.deepEqual(await next(), { type: 'agent_response', event_id: 1, content, is_final: final })
  }
  const second = [...first, { role: 'agent', content: 'Shared reply' }, { role: 'user', content: 'Voice second' }]
  socket.send(JSON.stringify({ type: 'user_transcript', event_id: 2, user_transcript: second }))
  for (let index = 0; index < 3; index++) assert.equal((await next()).event_id, 2)
  assert.deepEqual(inferences.map(request => request.input), [textHistory, first,
    second.map(message => ({ ...message, role: message.role === 'agent' ? 'assistant' : message.role }))])
  for (const request of inferences) {
    const { input: _input, stream, store, ...settings } = request
    assert.deepEqual(settings, conversationConfig)
    assert.equal(stream, true)
    assert.equal(store, false)
  }
  const closed = once(socket, 'close')
  app.emit('close')
  await closed
  await plugin.closeBundle()
  const replacement = createServer()
  await listen(replacement, port)
  await new Promise(resolve => replacement.close(resolve))
})

test('listener shutdown cancels an active provider turn and releases the bound port', async t => {
  const admission = createSpeechEngineAdmission()
  admission.register('conv_pending')
  let signal
  const runtime = createSpeechEngineServer({ apiKey: key, admission, port: 0,
    provider: async function* (_messages, turnSignal) {
      signal = turnSignal
      yield { type: 'delta', text: 'Pending' }
      await new Promise(resolve => turnSignal.addEventListener('abort', resolve, { once: true }))
    },
  })
  await runtime.listen()
  const port = runtime.server.address().port
  const socket = new WebSocket(`ws://127.0.0.1:${port}/speech-engine/upstream`, { headers: { 'X-Elevenlabs-Speech-Engine-Authorization': jwt() } })
  t.after(async () => { socket.terminate(); await runtime.close(); admission.clear() })
  const next = messages(socket)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'init', conversation_id: 'conv_pending' }))
  socket.send(JSON.stringify({ type: 'user_transcript', event_id: 1, user_transcript: [{ role: 'user', content: 'Pending' }] }))
  assert.equal((await next()).content, 'Pending')
  const closed = once(socket, 'close')
  await runtime.close()
  await closed
  assert.equal(signal.aborted, true)
  const replacement = createServer()
  await listen(replacement, port)
  await new Promise(resolve => replacement.close(resolve))
})
