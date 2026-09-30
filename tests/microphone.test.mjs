import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { measureVoiceLevel, Microphone } from '../src/lib/microphone.ts'

let frames, contexts, getUserMedia, amplitude, nextFrame
let savedGlobals

function makeStream() {
  const track = {
    readyState: 'live',
    onended: null,
    stop: mock.fn(function () { this.readyState = 'ended' }),
  }
  return { getTracks: () => [track], getAudioTracks: () => [track], track }
}

class AudioContextStub {
  state = 'suspended'
  source = { connect: mock.fn(), disconnect: mock.fn() }
  analyser = {
    fftSize: 0,
    disconnect: mock.fn(),
    getFloatTimeDomainData(samples) {
      for (let i = 0; i < samples.length; i++) {
        samples[i] = amplitude * Math.sin(i * Math.PI / 16)
      }
    },
  }
  constructor() { contexts.push(this) }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
  createAnalyser() { return this.analyser }
  createMediaStreamSource() { return this.source }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function advanceFrame(time) {
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((callback) => callback(time))
}

beforeEach(() => {
  frames = new Map()
  contexts = []
  nextFrame = 0
  amplitude = 0
  getUserMedia = mock.fn(async () => makeStream())
  const globals = {
    window: { isSecureContext: true, AudioContext: AudioContextStub },
    navigator: { mediaDevices: { getUserMedia } },
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    },
    cancelAnimationFrame: (id) => { frames.delete(id) },
  }
  savedGlobals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
})

afterEach(() => {
  mock.restoreAll()
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

test('silence and background noise stay quiet; stronger speech produces a larger, bounded signal', () => {
  assert.equal(measureVoiceLevel(new Float32Array()), 0)
  assert.equal(measureVoiceLevel(new Float32Array(1024)), 0)
  assert.equal(measureVoiceLevel(new Float32Array(1024).fill(0.004)), 0)
  const quiet = measureVoiceLevel(new Float32Array(1024).fill(0.025))
  const loud = measureVoiceLevel(new Float32Array(1024).fill(0.1))
  assert.ok(quiet > 0 && loud > quiet)
  assert.equal(measureVoiceLevel(new Float32Array(1024).fill(1)), 1)
})

test('only starts on request, samples real audio, and releases all resources on stop', async () => {
  const mic = new Microphone()
  assert.equal(getUserMedia.mock.callCount(), 0)
  assert.equal(contexts.length, 0)
  assert.equal(mic.getSnapshot().status, 'idle')
  await mic.start()
  assert.equal(mic.getSnapshot().status, 'listening')
  assert.equal(getUserMedia.mock.calls[0].arguments[0].video, false)
  assert.deepEqual(contexts[0].source.connect.mock.calls[0].arguments, [contexts[0].analyser])
  amplitude = 0.08
  advanceFrame(40)
  assert.ok(mic.getSnapshot().level > 0.3)
  amplitude = 0
  advanceFrame(80)
  assert.equal(mic.getSnapshot().level, 0)
  const stream = await getUserMedia.mock.calls[0].result
  mic.stop()
  assert.equal(stream.track.readyState, 'ended')
  assert.equal(stream.track.onended, null)
  assert.equal(contexts[0].state, 'closed')
  assert.equal(contexts[0].source.disconnect.mock.callCount(), 1)
  assert.equal(contexts[0].analyser.disconnect.mock.callCount(), 1)
  assert.equal(frames.size, 0)
  assert.equal(mic.getSnapshot().status, 'idle')
})

test('permission denial closes the audio context and allows a retry', async () => {
  getUserMedia.mock.mockImplementationOnce(async () => { throw new DOMException('Denied', 'NotAllowedError') })
  const mic = new Microphone()
  await mic.start()
  assert.equal(mic.getSnapshot().status, 'error')
  assert.match(mic.getSnapshot().error, /Allow microphone access/)
  assert.equal(contexts[0].state, 'closed')
  await mic.start()
  assert.equal(mic.getSnapshot().status, 'listening')
  assert.equal(mic.getSnapshot().error, null)
  mic.stop()
})

test('canceling a pending permission request stops the stream if it arrives later', async () => {
  const permission = deferred()
  getUserMedia.mock.mockImplementationOnce(() => permission.promise)
  const mic = new Microphone()
  const starting = mic.start()
  assert.equal(mic.getSnapshot().status, 'requesting')
  mic.toggle()
  const lateStream = makeStream()
  permission.resolve(lateStream)
  await starting
  assert.equal(lateStream.track.readyState, 'ended')
  assert.equal(contexts[0].state, 'closed')
  assert.equal(mic.getSnapshot().status, 'idle')
  assert.equal(frames.size, 0)
})

test('a stale permission result cannot replace or stop a newer listening session', async () => {
  const permission = deferred()
  getUserMedia.mock.mockImplementationOnce(() => permission.promise)
  const mic = new Microphone()
  const firstStart = mic.start()
  mic.stop()
  await mic.start()
  const activeStream = await getUserMedia.mock.calls[1].result
  const staleStream = makeStream()
  permission.resolve(staleStream)
  await firstStart
  assert.equal(staleStream.track.readyState, 'ended')
  assert.equal(activeStream.track.readyState, 'live')
  assert.equal(mic.getSnapshot().status, 'listening')
  assert.equal(contexts[1].state, 'running')
  mic.stop()
})

test('disconnection clears the signal and releases the microphone', async () => {
  const mic = new Microphone()
  await mic.start()
  const stream = await getUserMedia.mock.calls[0].result
  stream.track.onended()
  assert.equal(mic.getSnapshot().status, 'error')
  assert.equal(mic.getSnapshot().level, 0)
  assert.match(mic.getSnapshot().error, /disconnected/)
  assert.equal(contexts[0].state, 'closed')
  assert.equal(frames.size, 0)
})

test('an audio initialization failure releases an already granted microphone', async () => {
  mock.method(AudioContextStub.prototype, 'createAnalyser', () => { throw new Error('Audio initialization failed') })
  const mic = new Microphone()
  await mic.start()
  const stream = await getUserMedia.mock.calls[0].result
  assert.equal(mic.getSnapshot().status, 'error')
  assert.equal(stream.track.readyState, 'ended')
  assert.equal(contexts[0].state, 'closed')
})

test('insecure or unsupported browsers do not request microphone access', async () => {
  window.isSecureContext = false
  const mic = new Microphone()
  await mic.start()
  assert.match(mic.getSnapshot().error, /HTTPS or localhost/)
  assert.equal(getUserMedia.mock.callCount(), 0)
  assert.equal(contexts.length, 0)
  window.isSecureContext = true
  window.AudioContext = undefined
  await mic.start()
  assert.match(mic.getSnapshot().error, /does not support/)
  assert.equal(getUserMedia.mock.callCount(), 0)
})
