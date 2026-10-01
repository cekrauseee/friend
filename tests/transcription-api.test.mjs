import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { Readable, PassThrough } from 'node:stream'
import { test } from 'node:test'
import OpenAI from 'openai'
import { createTranscriptionApi } from '../server/transcription-api.ts'

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x01])
const mp4 = Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypisom'), 0, 0, 0, 0])

function exchange({ raw = webm, stream, method = 'POST', origin = 'http://localhost:5173',
  host = 'localhost:5173', media = 'audio/webm;codecs=opus', length } = {}) {
  const req = stream ?? Readable.from([raw])
  req.method = method
  req.headers = { origin, host, 'content-type': media,
    ...(length === undefined ? {} : { 'content-length': length }) }
  const res = new EventEmitter()
  res.destroyed = false
  res.writableEnded = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = JSON.parse(body); res.writableEnded = true }
  return { req, res }
}

async function request(handler, options) {
  const { req, res } = exchange(options)
  await handler(req, res)
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
  return res
}

function client(create = async () => ({ text: 'Hello' })) {
  return { audio: { transcriptions: { create } } }
}

function apiError(status, code) {
  return OpenAI.APIError.generate(status, { error: { message: 'private upstream details', code } },
    'private upstream details', new Headers())
}

test('uploads completed WebM/MP4 through the SDK using only the fixed transcription model', async () => {
  for (const [raw, media, filename] of [[webm, 'audio/webm;codecs=opus', 'recording.webm'],
    [mp4, 'audio/mp4', 'recording.mp4'], [mp4, 'video/mp4; codecs=mp4a.40.2', 'recording.mp4']]) {
    let calls = 0
    const openai = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (url, init) => {
      if (url === 'data:,') return new Response('') // SDK checks native FormData support.
      calls++
      assert.equal(url.toString(), 'https://api.openai.com/v1/audio/transcriptions')
      assert.equal(init.method, 'POST')
      const form = init.body
      assert.equal(form.get('model'), 'gpt-transcribe')
      assert.equal(form.get('response_format'), 'json')
      assert.deepEqual([...form.keys()].sort(), ['file', 'model', 'response_format'])
      const file = form.get('file')
      assert.equal(file.name, filename)
      assert.equal(file.type, media.split(';')[0])
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), raw)
      return Response.json({ text: '  Olá\nworld  ', usage: { internal: true } })
    } })
    const res = await request(createTranscriptionApi(undefined, openai), { raw, media })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { text: 'Olá\nworld' })
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(calls, 1)
  }
})

test('rejects invalid method, origin, media, bodies and byte limits before upstream use', async () => {
  let calls = 0
  const handler = createTranscriptionApi(undefined, client(async () => { calls++; return { text: 'Hello' } }))
  for (const [options, status, code] of [
    [{ method: 'GET' }, 405, 'method_not_allowed'],
    [{ origin: null }, 403, 'forbidden_origin'],
    [{ origin: 'https://outside.example' }, 403, 'forbidden_origin'],
    [{ origin: 'http://localhost:5174' }, 403, 'forbidden_origin'],
    [{ media: 'application/json' }, 415, 'unsupported_media_type'],
    [{ media: 'audio/webm-invalid' }, 415, 'unsupported_media_type'],
    [{ raw: Buffer.alloc(0) }, 400, 'invalid_request'],
    [{ raw: Buffer.from('malformed') }, 400, 'invalid_request'],
    [{ raw: webm, media: 'audio/mp4' }, 400, 'invalid_request'],
    [{ length: '-1' }, 400, 'invalid_request'],
    [{ length: '1' }, 400, 'invalid_request'],
    [{ length: '25000001' }, 413, 'request_too_large'],
    [{ raw: Buffer.alloc(25_000_001), length: '1' }, 413, 'request_too_large'],
    [{ stream: Readable.from([webm, Buffer.alloc(25_000_000)]) }, 413, 'request_too_large'],
  ]) {
    const res = await request(handler, options)
    assert.equal(res.status, status)
    assert.equal(res.body.error.code, code)
    if (status === 405) assert.equal(res.headers.Allow, 'POST')
  }
  assert.equal(calls, 0)
  assert.equal((await request(createTranscriptionApi(undefined))).body.error.code, 'not_configured')
  assert.equal((await request(createTranscriptionApi('  '))).status, 503)
})

test('returns safe actionable errors for upstream access, limits, timeout and empty transcripts', async () => {
  for (const [result, status, code] of [
    [apiError(401), 503, 'access_denied'], [apiError(403), 503, 'access_denied'],
    [apiError(404, 'model_not_found'), 503, 'access_denied'],
    [apiError(429), 429, 'rate_limited'], [apiError(500), 502, 'upstream_error'],
    [new Error('private upstream details'), 502, 'upstream_error'],
    [new OpenAI.APIConnectionTimeoutError(), 504, 'timeout'],
    [{ text: '' }, 502, 'empty_transcript'], [{ text: ' \n' }, 502, 'empty_transcript'],
    [{ text: 42 }, 502, 'empty_transcript'],
  ]) {
    const res = await request(createTranscriptionApi(undefined, client(async () => {
      if (result instanceof Error) throw result
      return result
    })))
    assert.equal(res.status, status)
    assert.equal(res.body.error.code, code)
    assert.ok(!JSON.stringify(res.body).includes('private'))
  }
})

test('disconnect during upload stops collection and never transcribes', async () => {
  let calls = 0
  const stream = new PassThrough()
  const { req, res } = exchange({ stream })
  const pending = createTranscriptionApi(undefined, client(async () => { calls++ }))(req, res)
  stream.write(webm)
  req.emit('aborted')
  await pending
  assert.equal(calls, 0)
  assert.equal(res.status, undefined)
  assert.equal(req.listenerCount('data'), 0)
  assert.equal(req.listenerCount('aborted'), 0)
  stream.destroy()
})

test('disconnect aborts upstream and suppresses late transcript results', async () => {
  const { req, res } = exchange()
  let finish
  let signal
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const pending = createTranscriptionApi(undefined, client((_settings, options) => {
    signal = options.signal
    started()
    return new Promise((resolve) => { finish = resolve })
  }))(req, res)
  await ready
  res.emit('close')
  await pending
  assert.equal(signal.aborted, true)
  finish({ text: 'late text' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.status, undefined)
  assert.equal(res.listenerCount('close'), 0)
})

test('deadline bounds stalled uploads and stalled upstream calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const upload = new PassThrough()
  const first = exchange({ stream: upload })
  let calls = 0
  const pendingUpload = createTranscriptionApi(undefined, client(async () => { calls++ }))(first.req, first.res)
  upload.write(webm)
  t.mock.timers.tick(120_000)
  await pendingUpload
  assert.equal(first.res.status, 504)
  assert.equal(first.res.body.error.code, 'timeout')
  assert.equal(calls, 0)
  assert.equal(upload.listenerCount('data'), 0)
  upload.destroy()

  let started
  const ready = new Promise((resolve) => { started = resolve })
  let signal
  const second = exchange()
  const pendingUpstream = createTranscriptionApi(undefined, client((_settings, options) => {
    signal = options.signal
    started()
    return new Promise(() => {})
  }))(second.req, second.res)
  await ready
  t.mock.timers.tick(120_000)
  await pendingUpstream
  assert.equal(signal.aborted, true)
  assert.equal(second.res.status, 504)
  assert.equal(second.res.body.error.code, 'timeout')
})

test('oversized uploads receive HTTP 413 without destroying the local socket first', async () => {
  const server = createServer(createTranscriptionApi(undefined, client()))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'audio/webm' } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.write(webm)
      req.end(Buffer.alloc(25_000_000))
    })
    assert.equal(status, 413)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
