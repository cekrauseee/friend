import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import OpenAI from 'openai'
import { createChatApi } from '../src/chat-api.ts'
import { conversationInstructions } from '../src/conversation-config.ts'

const history = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
  { role: 'user', content: ' Next question\n' },
]

function fakeClient(events, capture = () => {}) {
  return { responses: { create: async (settings, options) => {
    capture(settings, options)
    return (async function* () {
      for (const event of events) {
        if (event instanceof Error) throw event
        yield event
      }
    })()
  } } }
}

async function request(handler, {
  body = { messages: history }, raw, origin = 'http://localhost:5173',
  host = 'localhost:5173', method = 'POST', contentType = 'application/json',
  contentLength, onWrite,
} = {}) {
  const payload = raw ?? JSON.stringify(body)
  const req = Readable.from([payload])
  req.method = method
  req.headers = {
    origin, host, 'content-type': contentType,
    ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
  }
  const res = new EventEmitter()
  res.destroyed = false
  res.writableEnded = false
  res.chunks = []
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.write = (chunk) => {
    res.chunks.push(chunk)
    return onWrite?.(res, chunk) ?? true
  }
  res.end = (chunk) => {
    if (chunk) res.chunks.push(chunk)
    res.writableEnded = true
  }
  await handler(req, res)
  res.text = res.chunks.join('')
  res.json = () => JSON.parse(res.text)
  res.events = () => res.text.trimEnd().split('\n').map((line) => JSON.parse(line))
  return res
}

function apiError(status) {
  return OpenAI.APIError.generate(status, { error: { message: 'private upstream details' } },
    'private upstream details', new Headers())
}

test('streams ordered text with fixed settings, safe NDJSON framing and one done event', async () => {
  let settings
  let options
  const client = fakeClient([
    { type: 'response.created', response: { id: 'private-id' } },
    { type: 'response.output_text.delta', delta: 'First\nline' },
    { type: 'response.output_text.delta', delta: '' },
    { type: 'response.output_text.delta', delta: ' é' },
    { type: 'response.completed', response: { status: 'completed', id: 'private-id', usage: { secret: 1 } } },
    { type: 'response.output_text.delta', delta: 'ignored' },
  ], (s, o) => { settings = s; options = o })
  const res = await request(createChatApi(undefined, client))
  assert.equal(res.status, 200)
  assert.equal(res.headers['Content-Type'], 'application/x-ndjson; charset=utf-8')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.deepEqual(res.events(), [
    { type: 'delta', text: 'First\nline' },
    { type: 'delta', text: ' é' },
    { type: 'done' },
  ])
  assert.ok(res.text.endsWith('\n'))
  assert.ok(!res.text.includes('private-id'))
  assert.ok(!res.text.includes('usage'))
  assert.deepEqual(settings, {
    model: 'gpt-6-luna', instructions: conversationInstructions, reasoning: { effort: 'none' }, tools: [], tool_choice: 'none',
    input: history, stream: true, store: false, max_output_tokens: 8192,
  })
  assert.equal('previous_response_id' in settings, false)
  assert.equal('conversation' in settings, false)
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.signal.aborted, false)
})

test('rejects malformed history and browser model controls before calling upstream', async () => {
  let calls = 0
  const client = fakeClient([], () => { calls++ })
  const invalid = [
    { raw: '{' },
    { body: {} },
    { body: { messages: [] } },
    { body: { messages: [{ role: 'assistant', content: 'Hi' }] } },
    { body: { messages: [{ role: 'user', content: 'Hi' }, { role: 'user', content: 'Again' }] } },
    { body: { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }] } },
    { body: { messages: [{ role: 'user', content: ' \n ' }] } },
    { body: { messages: [{ role: 'user', content: 42 }] } },
    { body: { messages: [{ role: 'user', content: 'Hi', model: 'other' }] } },
    { body: { messages: [{ role: 'user', content: 'Hi' }], previous_response_id: 'private' } },
    { body: { messages: [{ role: 'user', content: 'Hi' }], tools: [] } },
    { raw: Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]) },
  ]
  for (const options of invalid) {
    const res = await request(createChatApi(undefined, client), options)
    assert.equal(res.status, 400)
    assert.equal(res.json().error.code, 'invalid_request')
  }
  assert.equal(calls, 0)
})

test('enforces byte, message and body budgets including a misleading content length', async () => {
  let calls = 0
  const client = fakeClient([], () => { calls++ })
  const cases = [
    { body: { messages: [{ role: 'user', content: 'é'.repeat(16_385) }] } },
    { body: { messages: Array.from({ length: 201 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x' })) } },
    { raw: JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(256 * 1024) }] }), contentLength: '1' },
    { contentLength: String(256 * 1024 + 1) },
  ]
  for (const options of cases) {
    const res = await request(createChatApi(undefined, client), options)
    assert.equal(res.status, 413)
    assert.equal(res.json().error.code, 'request_too_large')
  }
  assert.equal(calls, 0)
})

test('an oversized HTTP upload receives 413 while the body is still streaming', async () => {
  const server = createServer(createChatApi(undefined, fakeClient([])))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const result = await new Promise((resolve, reject) => {
      const upload = httpRequest({
        host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      }, (response) => {
        let body = ''
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }))
      })
      upload.on('error', reject)
      upload.write('x'.repeat(256 * 1024 + 1))
      upload.end()
    })
    assert.equal(result.status, 413)
    assert.equal(result.body.error.code, 'request_too_large')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('checks method, local origin, media type and missing key without upstream use', async () => {
  let calls = 0
  const client = fakeClient([], () => { calls++ })
  const cases = [
    [{ method: 'GET' }, 405, 'method_not_allowed'],
    [{ origin: null }, 403, 'forbidden_origin'],
    [{ origin: 'https://elsewhere.example' }, 403, 'forbidden_origin'],
    [{ origin: 'http://localhost:5174' }, 403, 'forbidden_origin'],
    [{ contentType: 'text/plain' }, 415, 'unsupported_media_type'],
  ]
  for (const [options, status, code] of cases) {
    const res = await request(createChatApi(undefined, client), options)
    assert.equal(res.status, status)
    assert.equal(res.json().error.code, code)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    if (status === 405) assert.equal(res.headers.Allow, 'POST')
  }
  const missing = await request(createChatApi(undefined))
  assert.equal(missing.status, 503)
  assert.equal(missing.json().error.code, 'not_configured')
  assert.equal(calls, 0)
})

test('maps pre-stream upstream errors to safe JSON statuses', async () => {
  for (const [status, expectedStatus, code] of [
    [429, 429, 'rate_limited'], [401, 503, 'access_denied'],
    [403, 503, 'access_denied'], [500, 502, 'upstream_error'],
  ]) {
    const client = { responses: { create: async () => { throw apiError(status) } } }
    const res = await request(createChatApi(undefined, client))
    assert.equal(res.status, expectedStatus)
    assert.equal(res.json().error.code, code)
    assert.ok(!res.text.includes('private upstream'))
  }
})

test('maps midstream failures to one typed error after existing deltas', async () => {
  for (const [failure, code] of [
    [apiError(429), 'rate_limited'], [apiError(401), 'access_denied'],
    [new Error('private upstream details'), 'upstream_error'],
    [{ type: 'response.failed' }, 'incomplete_response'],
    [{ type: 'response.incomplete' }, 'incomplete_response'],
    [{ type: 'error', code: 'rate_limit_exceeded', message: 'private upstream details' }, 'rate_limited'],
  ]) {
    const client = fakeClient([{ type: 'response.output_text.delta', delta: 'partial' }, failure])
    const res = await request(createChatApi(undefined, client))
    assert.deepEqual(res.events().map(({ type }) => type), ['delta', 'error'])
    assert.equal(res.events()[1].code, code)
    assert.ok(!res.text.includes('private upstream'))
  }
})

test('EOF, empty completion and non-completed status never become success', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'partial' }],
    [{ type: 'response.completed', response: { status: 'completed' } }],
    [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.completed', response: { status: 'incomplete' } }],
  ]) {
    const res = await request(createChatApi(undefined, fakeClient(events)))
    assert.equal(res.events().at(-1).code, 'incomplete_response')
    assert.equal(res.events().filter((event) => event.type === 'done' || event.type === 'error').length, 1)
  }
})

test('client disconnect aborts upstream and sends no terminal event', async () => {
  let signal
  const client = fakeClient([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.output_text.delta', delta: 'late' },
  ], (_settings, options) => { signal = options.signal })
  const res = await request(createChatApi(undefined, client), {
    onWrite(response) {
      response.destroyed = true
      response.emit('close')
    },
  })
  assert.equal(signal.aborted, true)
  assert.deepEqual(res.events(), [{ type: 'delta', text: 'partial' }])
})

test('waits for write backpressure before advancing upstream', async () => {
  let advanced = false
  const client = { responses: { create: async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: 'first' }
    advanced = true
    yield { type: 'response.completed', response: { status: 'completed' } }
  })() } }
  const res = await request(createChatApi(undefined, client), {
    onWrite(response) {
      assert.equal(advanced, false)
      setImmediate(() => response.emit('drain'))
      return false
    },
  })
  assert.deepEqual(res.events(), [{ type: 'delta', text: 'first' }, { type: 'done' }])
})
