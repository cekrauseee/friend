import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { VoiceSession } from '../src/lib/voice-session.ts'

let saved, frames, contexts, request, sessions, conversations, options, sdk, nextFrame
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function conversation() {
  const call = {
    input: 0, output: 0, frequencies: new Uint8Array(1024),
    endSession: mock.fn(async () => {}), setMicMuted: mock.fn(), setVolume: mock.fn(),
    getInputVolume() { return this.input }, getOutputVolume() { return this.output },
    getInputByteFrequencyData() { return this.frequencies },
  }
  conversations.push(call)
  return call
}
function session(overrides = {}) {
  const result = new VoiceSession({ startElevenLabs: sdk, ...overrides })
  sessions.push(result)
  return result
}
async function status(call, expected) {
  if (call.getSnapshot().status === expected) return
  await new Promise((resolve) => {
    const unsubscribe = call.subscribe(() => {
      if (call.getSnapshot().status === expected) { unsubscribe(); resolve() }
    })
  })
}
function frame(time) {
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((callback) => callback(time))
}
function token() { return Response.json({ provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'transient-token' }, { status: 201 }) }

beforeEach(() => {
  frames = new Map(); contexts = []; sessions = []; conversations = []; nextFrame = 0; options = null
  request = mock.fn(async (path) => path === '/api/voice-provider' ? Response.json({ provider: 'elevenlabs' }) : token())
  sdk = mock.fn(async (config) => {
    options = config
    const call = conversation()
    config.onConversationCreated(call)
    config.onConnect()
    return call
  })
  const globals = {
    window: { isSecureContext: true, AudioContext: class {
      state = 'running'
      constructor() { contexts.push(this) }
      resume = mock.fn(async () => {})
      close = mock.fn(async () => { this.state = 'closed' })
    }, RTCPeerConnection: class {} },
    navigator: { mediaDevices: { getUserMedia: mock.fn() } },
    fetch: request,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id) => frames.delete(id),
  }
  saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.entries(globals).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }))
})
afterEach(() => {
  sessions.forEach((call) => call.dispose())
  mock.restoreAll()
  saved.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key])
})

test('ElevenLabs receives only the transient token and public WebRTC callbacks, never an agent override', async () => {
  const call = session()
  await call.start()
  assert.equal(call.getSnapshot().status, 'connected')
  assert.equal(options.conversationToken, 'transient-token')
  assert.equal(options.connectionType, 'webrtc')
  assert.equal(options.agentId, undefined)
  assert.equal(options.overrides, undefined)
  assert.deepEqual(request.mock.calls.map(({ arguments: args }) => [args[0], args[1].method]), [
    ['/api/voice-provider', 'GET'], ['/api/elevenlabs-session', 'POST'],
  ])
  assert.equal(navigator.mediaDevices.getUserMedia.mock.callCount(), 0)
  assert.equal(contexts[0].state, 'closed')
})

test('OpenAI receives the gesture-resumed audio context and keeps its own snapshot/end contract', async () => {
  request.mock.mockImplementation(async () => Response.json({ provider: 'openai' }))
  let listener
  let state = { status: 'idle', error: null, inputBands: [], outputLevel: 0 }
  const engine = {
    getSnapshot: () => state,
    subscribe: mock.fn((fn) => { listener = fn; return () => { listener = null } }),
    start: mock.fn(async (context) => {
      assert.equal(context, contexts[0]); assert.equal(context.resume.mock.callCount(), 1)
      state = { ...state, status: 'connected' }; listener()
    }),
    end: mock.fn(() => { state = { ...state, status: 'closing' }; listener() }),
    dispose: mock.fn(() => {}),
  }
  const call = session({ createOpenAI: () => engine })
  await call.start()
  assert.equal(call.getSnapshot().status, 'connected')
  assert.equal(sdk.mock.callCount(), 0)
  assert.equal(request.mock.callCount(), 1)
  call.end()
  assert.equal(call.getSnapshot().status, 'closing')
  call.dispose()
  assert.equal(listener, null)
  assert.equal(engine.dispose.mock.callCount(), 1)
})

for (const stage of ['discovery', 'token']) {
  test(`cancel during ${stage} aborts the request and ignores late responses`, async () => {
    const waiting = deferred(), began = deferred()
    request.mock.mockImplementation(async (path) => {
      if (stage === 'discovery' || path === '/api/elevenlabs-session') { began.resolve(); return waiting.promise }
      return Response.json({ provider: 'elevenlabs' })
    })
    const call = session(), starting = call.start()
    await began.promise
    call.end()
    assert.equal(request.mock.calls.at(-1).arguments[1].signal.aborted, true)
    waiting.resolve(stage === 'discovery' ? Response.json({ provider: 'elevenlabs' }) : token())
    await starting
    assert.equal(call.getSnapshot().status, 'idle')
    assert.equal(sdk.mock.callCount(), 0)
    assert.equal(contexts[0].state, 'closed')
  })
}

test('cancel during SDK-owned startup silences/closes a late created conversation exactly once', async () => {
  const waiting = deferred(), began = deferred()
  sdk.mock.mockImplementation((config) => { options = config; began.resolve(); return waiting.promise })
  const call = session(), starting = call.start()
  await began.promise
  call.dispose()
  assert.equal(call.getSnapshot().status, 'closing')
  const closed = deferred()
  const late = conversation()
  late.endSession.mock.mockImplementation(() => closed.promise)
  options.onConversationCreated(late)
  options.onConnect()
  options.onModeChange({ mode: 'speaking' })
  waiting.resolve(late)
  await Promise.resolve()
  assert.equal(call.getSnapshot().status, 'closing')
  closed.resolve()
  await starting
  assert.equal(call.getSnapshot().status, 'idle')
  assert.equal(late.setMicMuted.mock.calls[0].arguments[0], true)
  assert.deepEqual(late.setVolume.mock.calls[0].arguments[0], { volume: 0 })
  assert.equal(late.endSession.mock.callCount(), 1)
  assert.equal(frames.size, 0)
})

test('pending startup excludes a new call; old callbacks cannot affect the later retry', async () => {
  const waiting = deferred(), began = deferred()
  let oldOptions
  sdk.mock.mockImplementationOnce((config) => { oldOptions = config; began.resolve(); return waiting.promise })
  const call = session(), first = call.start()
  await began.promise
  call.dispose()
  assert.equal(call.getSnapshot().status, 'closing')
  await call.start()
  assert.equal(sdk.mock.callCount(), 1)
  oldOptions.onError()
  oldOptions.onDisconnect({ reason: 'error' })
  waiting.resolve(conversation())
  await first
  assert.equal(call.getSnapshot().status, 'idle')
  await call.start()
  oldOptions.onError()
  oldOptions.onDisconnect({ reason: 'error' })
  assert.equal(call.getSnapshot().status, 'connected')
  assert.equal(conversations[0].endSession.mock.callCount(), 1)
  assert.equal(conversations[1].endSession.mock.callCount(), 0)
})

test('input bands follow only microphone frequencies; output follows measured agent audio and interruptions', async () => {
  const call = session()
  await call.start()
  const audio = conversations[0]
  audio.input = 0.4; audio.frequencies.fill(180)
  frame(40)
  assert.ok(call.getSnapshot().inputBands.some((band) => band > 0))
  assert.equal(call.getSnapshot().outputLevel, 0)
  audio.input = 0; audio.frequencies.fill(0); audio.output = 0.6
  options.onModeChange({ mode: 'speaking' })
  frame(80)
  assert.equal(call.getSnapshot().outputLevel, 0.6)
  frame(2000)
  assert.ok(call.getSnapshot().inputBands.every((band) => band === 0))
  options.onInterruption()
  assert.equal(call.getSnapshot().outputLevel, 0)
  frame(2040)
  assert.equal(call.getSnapshot().outputLevel, 0)
})

test('ending silences immediately, waits for SDK cleanup and ignores stale disconnect callbacks', async () => {
  const done = deferred()
  const call = session()
  await call.start()
  const audio = conversations[0]
  audio.endSession.mock.mockImplementation(() => done.promise)
  call.end(); call.end()
  assert.equal(call.getSnapshot().status, 'closing')
  assert.equal(audio.endSession.mock.callCount(), 1)
  assert.equal(audio.setMicMuted.mock.callCount(), 1)
  assert.equal(frames.size, 0)
  options.onDisconnect({ reason: 'error' })
  assert.equal(call.getSnapshot().status, 'closing')
  done.resolve()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(call.getSnapshot().status, 'idle')
})

test('SDK failures close once, redact private errors and allow retry', async () => {
  sdk.mock.mockImplementationOnce(async (config) => {
    const audio = conversation(); config.onConversationCreated(audio)
    throw new Error('private-token-and-upstream-detail')
  })
  const call = session()
  await call.start()
  await status(call, 'error')
  assert.equal(call.getSnapshot().status, 'error')
  assert.doesNotMatch(call.getSnapshot().error, /private/)
  assert.equal(conversations[0].endSession.mock.callCount(), 1)
  await call.start()
  assert.equal(call.getSnapshot().status, 'connected')
})

for (const fault of ['provider', 'model', 'token', 'service']) {
  test(`invalid ${fault} does not start an SDK conversation or fall back to OpenAI`, async () => {
    request.mock.mockImplementation(async (path) => {
      if (fault === 'provider') return Response.json({ provider: 'other' })
      if (path === '/api/voice-provider') return Response.json({ provider: 'elevenlabs' })
      if (fault === 'service') return Response.json({ error: 'Voice calls are not configured yet.' }, { status: 503 })
      return Response.json({ provider: 'elevenlabs', model: fault === 'model' ? 'other' : 'eleven_v4_turbo', conversationToken: fault === 'token' ? '' : 'token' })
    })
    const createOpenAI = mock.fn()
    const call = session({ createOpenAI })
    await call.start()
    assert.equal(call.getSnapshot().status, 'error')
    assert.equal(sdk.mock.callCount(), 0)
    assert.equal(createOpenAI.mock.callCount(), 0)
    if (fault === 'service') assert.equal(call.getSnapshot().error, 'Voice calls are not configured yet.')
  })
}

test('unexpected disconnect and analyser failure release SDK-owned resources', async () => {
  const call = session()
  await call.start()
  options.onDisconnect({ reason: 'error' })
  await status(call, 'error')
  assert.equal(call.getSnapshot().status, 'error')
  assert.equal(conversations[0].endSession.mock.callCount(), 1)
  await call.start()
  conversations[1].getInputByteFrequencyData = () => { throw new Error('device gone') }
  frame(40)
  await status(call, 'error')
  assert.equal(call.getSnapshot().status, 'error')
  assert.equal(conversations[1].endSession.mock.callCount(), 1)
  assert.equal(frames.size, 0)
})


test('startup timeout holds closing until SDK-owned startup and cleanup settle', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const waiting = deferred(), began = deferred()
  sdk.mock.mockImplementation((config) => { options = config; began.resolve(); return waiting.promise })
  const call = session(), starting = call.start()
  await began.promise
  mock.timers.tick(30_000)
  assert.equal(call.getSnapshot().status, 'closing')
  assert.equal(request.mock.calls[1].arguments[1].signal.aborted, true)
  waiting.resolve(conversation())
  await starting
  assert.equal(call.getSnapshot().status, 'error')
  assert.match(call.getSnapshot().error, /too long/)
  assert.equal(conversations[0].endSession.mock.callCount(), 1)
  mock.timers.reset()
})

test('startup error callback keeps mic excluded until its pending handle is closed', async () => {
  const waiting = deferred(), began = deferred()
  sdk.mock.mockImplementation((config) => { options = config; began.resolve(); return waiting.promise })
  const call = session(), starting = call.start()
  await began.promise
  options.onError('private-details')
  assert.equal(call.getSnapshot().status, 'closing')
  await call.start()
  assert.equal(sdk.mock.callCount(), 1)
  waiting.resolve(conversation())
  await starting
  assert.equal(call.getSnapshot().status, 'error')
  assert.doesNotMatch(call.getSnapshot().error, /private/)
})
