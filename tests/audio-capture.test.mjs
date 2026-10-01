import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { AudioCapture } from '../src/lib/audio-capture.ts'
import { TranscriptionError } from '../src/lib/transcription-client.ts'

const originals = Object.fromEntries(['navigator', 'MediaRecorder', 'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let recorders, contexts, streams, frames, capture, uploads, permission, supported, nextFrame

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function stream() {
  const track = { onended: null, stops: 0, stop() { this.stops++ } }
  const value = { track, getTracks: () => [track] }
  streams.push(value)
  return value
}

beforeEach(() => {
  recorders = []; contexts = []; streams = []; frames = new Map(); uploads = []
  supported = 'audio/webm;codecs=opus'; nextFrame = 1
  permission = () => Promise.resolve(stream())
  class Recorder {
    static isTypeSupported(type) { return type === supported }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; recorders.push(this) }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice }
    stop() {
      this.state = 'inactive'
      const data = this.finalData ?? new Blob(['recorded audio'])
      queueMicrotask(() => { this.ondataavailable?.({ data }); this.onstop?.() })
    }
  }
  class Context {
    constructor() { this.state = 'running'; this.disconnections = 0; this.level = 0.15; contexts.push(this) }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
    createAnalyser() {
      return {
        fftSize: 1024, frequencyBinCount: 512,
        getFloatTimeDomainData: (samples) => samples.fill(this.level),
        getByteFrequencyData: (frequencies) => frequencies.fill(180),
        disconnect: () => this.disconnections++,
      }
    }
    createMediaStreamSource() { return { connect() {}, disconnect: () => this.disconnections++ } }
  }
  const globals = {
    navigator: { mediaDevices: { getUserMedia: () => permission() } }, MediaRecorder: Recorder, AudioContext: Context,
    requestAnimationFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id },
    cancelAnimationFrame: (id) => frames.delete(id),
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  capture = new AudioCapture(async (audio, signal) => { uploads.push({ audio, signal }); return ' hello ' })
})

afterEach(() => {
  capture.dispose()
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

function assertReleased() {
  assert.ok(streams.every(({ track }) => track.stops === 1))
  assert.ok(contexts.every((context) => context.state === 'closed'))
  assert.equal(frames.size, 0)
}

test('recording stays local, waveform reads actual stream energy, and cancel discards everything', async () => {
  await capture.start()
  assert.equal(capture.getSnapshot().status, 'recording')
  assert.equal(uploads.length, 0)
  const [id, frame] = frames.entries().next().value
  frames.delete(id); frame(100)
  assert.ok(capture.getSnapshot().inputBands.some((band) => band > 0))
  assert.equal(recorders[0].timeslice, 1000)
  capture.cancel()
  await Promise.resolve()
  assert.equal(capture.getSnapshot().status, 'idle')
  assert.equal(uploads.length, 0)
  assert.equal(await capture.finalize('send'), null)
  assertReleased()
  assert.equal(contexts[0].disconnections, 2)
})

test('explicit finalize uploads exactly once and preserves the first intent', async () => {
  await capture.start()
  const result = capture.finalize('insert')
  assert.equal(capture.getSnapshot().status, 'processing')
  assert.equal(await capture.finalize('send'), null)
  assertReleased()
  assert.deepEqual(await result, { text: 'hello', intent: 'insert' })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].audio.type, 'audio/webm;codecs=opus')
  assert.equal(await uploads[0].audio.text(), 'recorded audio')
  assert.equal(capture.getSnapshot().status, 'idle')
})

test('send intent and MP4 fallback retain the browser container type', async () => {
  supported = 'video/mp4'
  await capture.start()
  assert.deepEqual(await capture.finalize('send'), { text: 'hello', intent: 'send' })
  assert.equal(uploads[0].audio.type, 'video/mp4')
})

test('cancel before the recorder stop event prevents any upload', async () => {
  await capture.start()
  const result = capture.finalize('insert')
  capture.cancel()
  assert.equal(await result, null)
  assert.equal(uploads.length, 0)
  assertReleased()
})

test('cancel aborts transcription and a late result cannot affect a new capture', async () => {
  const transcription = deferred()
  capture = new AudioCapture((audio, signal) => { uploads.push({ audio, signal }); return transcription.promise })
  await capture.start()
  const result = capture.finalize('send')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(uploads.length, 1)
  capture.cancel()
  assert.equal(uploads[0].signal.aborted, true)
  await capture.start()
  transcription.resolve('stale text')
  assert.equal(await result, null)
  assert.equal(capture.getSnapshot().status, 'recording')
  capture.cancel()
  assertReleased()
})

test('cancel during permission closes context and stops late microphone tracks', async () => {
  const microphone = deferred()
  permission = () => microphone.promise
  const starting = capture.start()
  assert.equal(capture.getSnapshot().status, 'starting')
  capture.cancel()
  microphone.resolve(stream())
  await starting
  assert.equal(recorders.length, 0)
  assert.equal(uploads.length, 0)
  assert.equal(capture.getSnapshot().status, 'idle')
  assertReleased()
})

test('late permission cannot replace the stream of a newer capture', async () => {
  const microphone = deferred()
  permission = () => microphone.promise
  const starting = capture.start()
  capture.cancel()
  permission = () => Promise.resolve(stream())
  await capture.start()
  const newerStream = streams[0]
  microphone.resolve(stream())
  await starting
  assert.equal(capture.getSnapshot().status, 'recording')
  assert.equal(newerStream.track.stops, 0)
  assert.equal(streams[1].track.stops, 1)
  assert.equal(recorders.length, 1)
})

test('permission timeout closes startup resources and discards a late stream', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const microphone = deferred()
  permission = () => microphone.promise
  const starting = capture.start()
  context.mock.timers.tick(30_000)
  assert.match(capture.getSnapshot().error, /Microphone access took too long/)
  microphone.resolve(stream())
  await starting
  assert.equal(recorders.length, 0)
  assert.equal(uploads.length, 0)
  assertReleased()
})

test('unexpected recorder stop fails instead of implicitly uploading', async () => {
  await capture.start()
  recorders[0].stop()
  await Promise.resolve()
  assert.match(capture.getSnapshot().error, /Recording stopped unexpectedly/)
  assert.equal(uploads.length, 0)
  assertReleased()
})

test('competing starts do not open a second microphone', async () => {
  const microphone = deferred()
  permission = () => microphone.promise
  const starting = capture.start()
  await capture.start()
  microphone.resolve(stream())
  await starting
  await capture.start()
  assert.equal(contexts.length, 1)
  assert.equal(recorders.length, 1)
})

test('permission errors are recoverable and allow a new successful capture', async () => {
  permission = () => Promise.reject(new DOMException('private detail', 'NotAllowedError'))
  await capture.start()
  assert.equal(capture.getSnapshot().status, 'error')
  assert.match(capture.getSnapshot().error, /Allow microphone access/)
  assertReleased()
  permission = () => Promise.resolve(stream())
  await capture.start()
  assert.deepEqual(await capture.finalize('insert'), { text: 'hello', intent: 'insert' })
})

test('empty local recording fails without upload; quiet recordings are not rejected by meter heuristics', async () => {
  await capture.start()
  recorders[0].finalData = new Blob([])
  assert.equal(await capture.finalize('insert'), null)
  assert.match(capture.getSnapshot().error, /No audio was recorded/)
  assert.equal(uploads.length, 0)
  await capture.start()
  contexts[1].level = 0
  assert.deepEqual(await capture.finalize('insert'), { text: 'hello', intent: 'insert' })
  assert.equal(uploads.length, 1)
})

test('empty transcript and safe service failure expose recoverable errors and release audio', async () => {
  capture = new AudioCapture(async () => { throw new TranscriptionError('No speech was detected. Try again.', 'empty_transcript') })
  await capture.start()
  assert.equal(await capture.finalize('insert'), null)
  assert.match(capture.getSnapshot().error, /No speech was detected/)
  assertReleased()
  capture = new AudioCapture(async () => ' ')
  await capture.start()
  assert.equal(await capture.finalize('send'), null)
  assert.match(capture.getSnapshot().error, /No speech was detected/)
})

test('oversized buffered audio fails locally without upload', async () => {
  await capture.start()
  recorders[0].ondataavailable({ data: new Blob([new Uint8Array(25_000_001)]) })
  assert.equal(capture.getSnapshot().status, 'error')
  assert.match(capture.getSnapshot().error, /25 MB/)
  assert.equal(uploads.length, 0)
  assertReleased()
})

test('duration cap discards locally and never auto-uploads', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  await capture.start()
  context.mock.timers.tick(5 * 60 * 1000)
  assert.equal(capture.getSnapshot().status, 'error')
  assert.match(capture.getSnapshot().error, /5-minute limit/)
  assert.equal(uploads.length, 0)
  assertReleased()
})

test('processing timeout aborts upload and suppresses its late result', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const transcription = deferred()
  capture = new AudioCapture((audio, signal) => { uploads.push({ audio, signal }); return transcription.promise })
  await capture.start()
  const result = capture.finalize('insert')
  await new Promise((resolve) => setImmediate(resolve))
  context.mock.timers.tick(130_000)
  assert.equal(capture.getSnapshot().status, 'error')
  assert.equal(uploads[0].signal.aborted, true)
  transcription.resolve('late text')
  assert.equal(await result, null)
})

test('microphone disconnect and recorder failure stop all resources', async () => {
  await capture.start()
  streams[0].track.onended()
  assert.match(capture.getSnapshot().error, /Microphone disconnected/)
  assertReleased()
  await capture.start()
  recorders[1].onerror()
  assert.match(capture.getSnapshot().error, /Recording failed/)
  assertReleased()
})

test('unsupported formats fail before microphone access', async () => {
  supported = 'audio/ogg'
  await capture.start()
  assert.match(capture.getSnapshot().error, /WebM or MP4/)
  assert.equal(streams.length, 0)
  assert.equal(contexts.length, 0)
})
