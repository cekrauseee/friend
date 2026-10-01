import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { transcribeAudio, TranscriptionError } from '../src/lib/transcription-client.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const audio = new Blob(['audio bytes'], { type: 'audio/webm;codecs=opus' })

test('posts raw recorded bytes with their MIME type and abort signal', async () => {
  const signal = new AbortController().signal
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/transcription')
    assert.equal(options.method, 'POST')
    assert.equal(options.body, audio)
    assert.equal(options.headers['Content-Type'], audio.type)
    assert.equal(options.signal, signal)
    return Response.json({ text: ' transcribed text ' })
  }
  assert.equal(await transcribeAudio(audio, signal), 'transcribed text')
})

test('known server errors retain actionable messages but unknown errors remain private', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 'empty_transcript', message: 'Record a new message.' } }, { status: 502 })
  await assert.rejects(transcribeAudio(audio, new AbortController().signal),
    (error) => error instanceof TranscriptionError && error.code === 'empty_transcript' && error.message === 'Record a new message.')
  globalThis.fetch = async () => Response.json({ error: { code: 'private_error', message: 'secret detail' } }, { status: 502 })
  await assert.rejects(transcribeAudio(audio, new AbortController().signal), /Could not transcribe/)
})

test('empty or malformed success, wrong content type and network errors fail safely', async () => {
  const cases = [Response.json({ text: ' ' }), Response.json({ text: 5 }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response('private detail', { status: 502 })]
  for (const response of cases) {
    globalThis.fetch = async () => response
    await assert.rejects(transcribeAudio(audio, new AbortController().signal), TranscriptionError)
  }
  globalThis.fetch = async () => { throw new Error('private network detail') }
  await assert.rejects(transcribeAudio(audio, new AbortController().signal), /Could not transcribe/)
})
