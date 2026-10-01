import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { sendTextChat, TextChatError } from '../src/lib/text-chat-client.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function ndjson(chunks, onCancel) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (!onCancel) controller.close()
    },
    cancel() { onCancel?.() },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
}

const bytes = (text) => new TextEncoder().encode(text)
const messages = [{ role: 'user', content: 'Hello' }]

test('posts ordered messages and decodes split lines and UTF-8 before done', async () => {
  const data = bytes('{"type":"delta","text":"Hi 🌊"}\r\n{"type":"delta","text":"!"}\n{"type":"done"}')
  const emoji = data.indexOf(0xf0)
  const chunks = [data.slice(0, 9), data.slice(9, emoji + 2), data.slice(emoji + 2, data.length - 4), data.slice(data.length - 4)]
  let request
  globalThis.fetch = async (_url, options) => {
    request = options
    assert.equal(_url, '/api/chat')
    return ndjson(chunks)
  }
  const deltas = []
  const signal = new AbortController().signal
  await sendTextChat(messages, signal, (text) => deltas.push(text))
  assert.deepEqual(deltas, ['Hi 🌊', '!'])
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.signal, signal)
  assert.deepEqual(JSON.parse(request.body), { messages })
})

test('done resolves promptly without waiting for the stream to close', async () => {
  let canceled = false
  globalThis.fetch = async () => ndjson([bytes('{"type":"delta","text":"ok"}\n{"type":"done"}\n')], () => { canceled = true })
  await sendTextChat(messages, new AbortController().signal, () => {})
  await Promise.resolve()
  assert.equal(canceled, true)
})

test('HTTP and streamed safe service errors retain their messages', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 'request_too_large', message: 'Conversation is too long.' } }, { status: 413 })
  await assert.rejects(sendTextChat(messages, new AbortController().signal, () => {}),
    (error) => error instanceof TextChatError && error.code === 'request_too_large' && error.message === 'Conversation is too long.')

  const deltas = []
  globalThis.fetch = async () => ndjson([bytes('{"type":"delta","text":"partial"}\n{"type":"error","code":"rate_limited","message":"Try shortly."}\n')])
  await assert.rejects(sendTextChat(messages, new AbortController().signal, (text) => deltas.push(text)),
    (error) => error instanceof TextChatError && error.code === 'rate_limited' && error.message === 'Try shortly.')
  assert.deepEqual(deltas, ['partial'])
})

test('unexpected EOF, malformed lines, wrong content type, and invalid HTTP bodies fail safely', async () => {
  const fallback = /Could not complete the reply/
  const cases = [
    ndjson([bytes('{"type":"done"}\n')]),
    ndjson([bytes('{"type":"delta","text":"partial"}\n')]),
    ndjson([bytes('{"type":"delta","text":"partial"}\n\n{"type":"done"}\n')]),
    ndjson([bytes('{"type":"delta","text":"partial"}\n{not json}\n')]),
    new Response('{"type":"done"}\n', { headers: { 'content-type': 'text/plain' } }),
    Response.json({ error: { code: 'unknown', message: 'private upstream detail' } }, { status: 502 }),
  ]
  for (const response of cases) {
    globalThis.fetch = async () => response
    await assert.rejects(sendTextChat(messages, new AbortController().signal, () => {}), fallback)
  }
  globalThis.fetch = async () => { throw new Error('private network detail') }
  await assert.rejects(sendTextChat(messages, new AbortController().signal, () => {}), fallback)
})
