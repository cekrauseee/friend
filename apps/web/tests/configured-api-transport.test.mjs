import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'

// Model Vite's public env replacement while exercising the real browser clients in Node.
const base = 'https://api.example.test/gateway'
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.endsWith('/src/lib/api-url.ts')) {
      return { ...result, source: String(result.source).replace('import.meta.env?.VITE_API_BASE_URL', JSON.stringify(`${base}/`)) }
    }
    return result
  },
})
const { sendTextChat } = await import('../src/lib/text-chat-client.ts')
const { transcribeAudio } = await import('../src/lib/transcription-client.ts')
const { createTextAccess } = await import('../src/lib/text-access.ts')
const { VoiceSession } = await import('../src/lib/voice-session.ts')
const { LiveSession } = await import('../src/lib/live-session.ts')
hooks.deregister()
const savedFetch = globalThis.fetch
after(() => { globalThis.fetch = savedFetch })

test('configured chat preserves JSON request, abort signal and incremental NDJSON delivery', async () => {
  const signal = new AbortController().signal
  const messages = [{ role: 'user', content: 'hello' }]
  const encoder = new TextEncoder()
  let stream
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${base}/api/chat`)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), { messages })
    assert.equal(options.signal, signal)
    return new Response(new ReadableStream({ start(controller) { stream = controller } }), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    })
  }
  const chunks = []
  const running = sendTextChat(messages, signal, (text) => chunks.push(text))
  stream.enqueue(encoder.encode('{"type":"delta","text":"hello"}\n'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(chunks, ['hello'])
  stream.enqueue(encoder.encode('{"type":"done"}\n'))
  await running
})

test('configured transcription preserves raw bytes, MIME type and abort signal', async () => {
  const signal = new AbortController().signal
  const audio = new Blob(['audio'], { type: 'audio/webm' })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${base}/api/transcription`)
    assert.equal(options.method, 'POST')
    assert.equal(options.body, audio)
    assert.equal(options.headers['Content-Type'], audio.type)
    assert.equal(options.signal, signal)
    return Response.json({ text: 'hello' })
  }
  assert.equal(await transcribeAudio(audio, signal), 'hello')
})

test('configured sign-in uses shared status/login/cancel paths and retains cancel keepalive', async () => {
  const calls = []
  const gate = createTextAccess({ openWindow: () => ({ opener: null, location: {}, close() {} }) })
  globalThis.fetch = async (url, options) => {
    calls.push(url)
    assert.equal(options.method, 'POST')
    if (url.endsWith('/status')) {
      assert.equal(options.keepalive, false)
      assert.ok(options.signal instanceof AbortSignal)
      return Response.json({ provider: 'codex', authenticated: false, login: null })
    }
    if (url.endsWith('/login')) {
      gate.cancel()
      return Response.json({ loginId: 'login', authUrl: 'https://auth.openai.com/authorize' })
    }
    assert.equal(options.keepalive, true)
    assert.equal(options.signal, undefined)
    return Response.json({ canceled: true })
  }
  await gate.enter(() => assert.fail('Canceled login must not enter chat'))
  assert.deepEqual(calls, [`${base}/api/text-access/status`, `${base}/api/text-access/login`, `${base}/api/text-access/cancel`])
  assert.equal(gate.getSnapshot().pending, false)
})


test('configured voice discovery/token and OpenAI negotiation preserve transport options', async () => {
  const calls = []
  const channel = { close() {}, readyState: 'open', send() {} }
  class Peer extends EventTarget {
    iceGatheringState = 'complete'
    addTrack() {}
    createDataChannel() { return channel }
    async createOffer() { return { type: 'offer', sdp: 'local-sdp' } }
    async setLocalDescription(offer) { this.localDescription = offer }
    async setRemoteDescription(answer) { assert.deepEqual(answer, { type: 'answer', sdp: 'remote-sdp' }) }
    getReceivers() { return [] }
    close() {}
  }
  const globals = {
    window: { isSecureContext: true, RTCPeerConnection: Peer,
      AudioContext: class {
        state = 'running'
        async resume() {}
        async close() {}
        createAnalyser() { return { frequencyBinCount: 512, disconnect() {} } }
        createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      },
      Audio: class { setAttribute() {}; pause() {} },
    },
    navigator: { mediaDevices: { getUserMedia: async () => {
      const track = { stop() {} }
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    } } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  }
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  const voice = new VoiceSession({ startElevenLabs: async (options) => {
    assert.equal(options.conversationToken, 'transient-token')
    assert.equal(options.connectionType, 'webrtc')
    throw new Error('Synthetic SDK failure')
  } })
  const live = new LiveSession()
  globalThis.fetch = async (url, options) => {
    calls.push(url)
    assert.ok(options.signal instanceof AbortSignal)
    if (url.endsWith('/voice-provider')) {
      assert.equal(options.method, 'GET')
      assert.equal(options.cache, 'no-store')
      return Response.json({ provider: 'elevenlabs' })
    }
    assert.equal(options.method, 'POST')
    if (url.endsWith('/elevenlabs-session')) {
      assert.equal(options.cache, 'no-store')
      return Response.json({ provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'transient-token' })
    }
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), { sdp: 'local-sdp' })
    return Response.json({ session: { id: 'session' }, transport: { type: 'webrtc', sdp: 'remote-sdp' } })
  }
  try {
    await voice.start()
    assert.equal(voice.getSnapshot().status, 'error')
    await live.start()
    assert.equal(live.getSnapshot().error, null)
    assert.deepEqual(calls, [`${base}/api/voice-provider`, `${base}/api/elevenlabs-session`, `${base}/api/session`])
  } finally {
    voice.dispose()
    live.dispose()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
