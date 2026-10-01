import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { createSpeechEngineBridge } from '../src/speech-engine.ts'
import { createSpeechEngineAdmission } from '../src/speech-engine-admission.ts'
import { verifySpeechEngineAuthorization } from '../src/speech-engine-auth.ts'

const key = 'local-test-secret'
const claims = () => ({
  iss: 'https://api.elevenlabs.io/convai/speech-engine',
  sub: 'convai_speech_engine_upstream', exp: Date.now() / 1000 + 60,
})
function jwt(payload = claims(), secret = createHash('sha256').update(key).digest(), header = { alg: 'HS256' }) {
  const body = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
const transcript = (eventId = 1, content = 'Hello', history = []) => ({
  type: 'user_transcript', event_id: eventId, user_transcript: [...history, { role: 'user', content }],
})
const reply = (eventId, content, final = false) => ({
  type: 'agent_response', event_id: eventId, content, is_final: final,
})
async function fixture(t, provider = async function* () { yield { type: 'delta', text: 'Hi' }; yield { type: 'done' } }, options = {}) {
  const admission = createSpeechEngineAdmission()
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  const bridge = createSpeechEngineBridge({ apiKey: key, provider, admission, ...options })
  bridge.attach(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}/speech-engine/upstream`
  const clients = []
  t.after(async () => {
    clients.forEach((client) => client.terminate())
    await bridge.close()
    await new Promise((resolve) => server.close(resolve))
    admission.clear()
  })
  async function connect(id = 'conv_1', token = jwt(), path = url) {
    const socket = new WebSocket(path, { headers: { 'X-ElevenLabs-Speech-Engine-Authorization': token } })
    clients.push(socket)
    const messages = []
    let waiter
    socket.on('message', (bytes) => { messages.push(JSON.parse(bytes.toString())); waiter?.(); waiter = undefined })
    socket.on('error', () => {})
    const close = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    const opened = await new Promise((resolve) => {
      socket.once('open', () => resolve(true))
      socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode) })
      socket.once('error', () => resolve(false))
    })
    if (opened === true && id !== null) socket.send(JSON.stringify({ type: 'init', conversation_id: id }))
    return {
      socket, opened, close, messages,
      send: (message) => socket.send(JSON.stringify(message)),
      async next() {
        if (!messages.length) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiter = undefined; reject(new Error('Response timeout')) }, 2000)
          waiter = () => { clearTimeout(timer); resolve() }
        })
        return messages.shift()
      },
    }
  }
  return { admission, server, bridge, connect }
}

test('official JWT validates signature, issuer, subject, algorithm and mandatory expiry with 60s leeway', () => {
  const now = Date.now()
  assert.equal(verifySpeechEngineAuthorization(jwt(), key, now), true)
  for (const payload of [
    { ...claims(), iss: 'wrong' }, { ...claims(), sub: 'wrong' },
    { ...claims(), exp: undefined }, { ...claims(), exp: '123' },
    { ...claims(), exp: now / 1000 - 61 }, { ...claims(), nbf: now / 1000 + 61 },
  ]) assert.equal(verifySpeechEngineAuthorization(jwt(payload), key, now), false)
  assert.equal(verifySpeechEngineAuthorization(jwt({ ...claims(), exp: now / 1000 - 59 }), key, now), true)
  assert.equal(verifySpeechEngineAuthorization(jwt(claims(), Buffer.from(key)), key), false)
  assert.equal(verifySpeechEngineAuthorization(jwt(claims(), undefined, { alg: 'none' }), key), false)
  for (const token of [undefined, [], 'not.jwt', `${jwt()}.extra`, 'a'.repeat(8193)]) {
    assert.equal(verifySpeechEngineAuthorization(token, key), false)
  }
})

test('admission is bounded, expiring, one-shot and rejects re-registration replay', () => {
  let now = 0
  const registry = createSpeechEngineAdmission({ ttlMs: 10, maxEntries: 1, now: () => now })
  assert.equal(registry.register('conv_1'), true)
  assert.equal(registry.consume('conv_unknown'), false)
  assert.equal(registry.consume('conv_1'), true)
  assert.equal(registry.consume('conv_1'), false)
  assert.equal(registry.register('conv_1'), false)
  assert.equal(registry.register('conv_2'), false)
  now = 10
  assert.equal(registry.consume('conv_1'), false)
  assert.equal(registry.register('conv_2'), true)
  registry.clear()
  assert.equal(registry.consume('conv_2'), false)
})

test('real handshake accepts official auth and rejects missing/bad JWT or wrong path before upgrade', async (t) => {
  const { connect, server } = await fixture(t)
  assert.equal((await connect(null)).opened, true)
  assert.equal((await connect(null, '')).opened, 401)
  assert.equal((await connect(null, jwt({ ...claims(), sub: 'wrong' }))).opened, 401)
  assert.equal((await connect(null, jwt(), 'ws://127.0.0.1:' + server.address().port + '/wrong')).opened, 404)
})

test('only an issued conversation ID may start inference and cannot replay across sockets', async (t) => {
  let calls = 0
  const { connect, admission } = await fixture(t, async function* () { calls++; yield { type: 'done' } })
  const unknown = await connect('conv_unknown')
  unknown.send(transcript())
  assert.equal((await unknown.close).code, 1008)
  admission.register('conv_1')
  const first = await connect()
  first.send({ type: 'ping' })
  assert.deepEqual(await first.next(), { type: 'pong' })
  const replay = await connect()
  assert.equal((await replay.close).code, 1008)
  assert.equal(calls, 0)
})

test('streams correlated fragments/final and full mapped history on successive turns', async (t) => {
  const received = []
  const { connect, admission } = await fixture(t, async function* (messages) {
    received.push(messages)
    yield { type: 'delta', text: 'A' }; yield { type: 'delta', text: 'B' }; yield { type: 'done' }
  })
  admission.register('conv_1')
  const client = await connect()
  client.send(transcript(10))
  assert.deepEqual(await client.next(), reply(10, 'A'))
  assert.deepEqual(await client.next(), reply(10, 'B'))
  assert.deepEqual(await client.next(), reply(10, '', true))
  const history = [{ role: 'user', content: 'Hello' }, { role: 'agent', content: 'AB' }]
  client.send(transcript(11, 'Again', history))
  assert.deepEqual(await client.next(), reply(11, 'A'))
  assert.deepEqual(await client.next(), reply(11, 'B'))
  assert.deepEqual(await client.next(), reply(11, '', true))
  assert.deepEqual(received, [
    [{ role: 'user', content: 'Hello' }],
    [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'AB' }, { role: 'user', content: 'Again' }],
  ])
  client.send({ type: 'ping' })
  assert.deepEqual(await client.next(), { type: 'pong' })
  const pong = once(client.socket, 'pong')
  client.socket.ping('transport')
  assert.equal((await pong)[0].toString(), 'transport')
  client.send({ type: 'close' })
  assert.equal((await client.close).code, 1000)
})

test('a completed event cannot be replayed on its session', async (t) => {
  const { connect, admission } = await fixture(t)
  admission.register('conv_1')
  const client = await connect()
  client.send(transcript(1))
  await client.next()
  assert.deepEqual(await client.next(), reply(1, '', true))
  client.send(transcript(1))
  assert.equal((await client.close).code, 1008)
  assert.deepEqual(client.messages, [])
})

test('independent concurrent sessions receive only their own transcript/provider output', async (t) => {
  const { connect, admission } = await fixture(t, async function* (messages) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    yield { type: 'delta', text: messages.at(-1).content }; yield { type: 'done' }
  })
  admission.register('conv_1'); admission.register('conv_2')
  const [one, two] = await Promise.all([connect('conv_1'), connect('conv_2')])
  one.send(transcript(1, 'One')); two.send(transcript(1, 'Two'))
  assert.deepEqual(await one.next(), reply(1, 'One'))
  assert.deepEqual(await two.next(), reply(1, 'Two'))
  assert.deepEqual(await one.next(), reply(1, '', true))
  assert.deepEqual(await two.next(), reply(1, '', true))
})

for (const [name, provider] of [
  ['exception', async function* () { throw new Error('secret upstream error') }],
  ['provider error', async function* () { yield { type: 'delta', text: 'Partial' }; yield { type: 'error', code: 'upstream_error', message: 'secret' } }],
  ['incomplete stream', async function* () { yield { type: 'delta', text: 'Partial' } }],
  ['empty completion', async function* () { yield { type: 'done' } }],
  ['output limit', async function* () { yield { type: 'delta', text: 'a'.repeat(64 * 1024 + 1) }; yield { type: 'done' } }],
]) test(`failed ${name} closes safely without a success final`, async (t) => {
  const { connect, admission } = await fixture(t, provider)
  admission.register('conv_1')
  const client = await connect()
  client.send(transcript())
  const result = await client.close
  assert.equal(result.code, 1011)
  assert.equal(result.reason, 'Could not complete the reply.')
  assert.equal(client.messages.some((message) => message.is_final), false)
})

function waitingProvider(onAbort) {
  return async function* (_messages, signal) {
    await new Promise((resolve) => signal.addEventListener('abort', () => { onAbort(); resolve() }, { once: true }))
    yield { type: 'delta', text: 'late' }; yield { type: 'done' }
  }
}
test('disconnect, turn timeout and shutdown abort active provider work without late responses', async (t) => {
  for (const mode of ['disconnect', 'timeout', 'shutdown']) {
    let aborted
    const abort = new Promise((resolve) => { aborted = resolve })
    const { connect, admission, bridge } = await fixture(t, waitingProvider(aborted), { turnTimeoutMs: mode === 'timeout' ? 20 : 2000 })
    admission.register('conv_1')
    const client = await connect()
    client.send(transcript())
    // Ping is processed after the synchronous start of inference on this socket.
    client.send({ type: 'ping' })
    assert.deepEqual(await client.next(), { type: 'pong' })
    if (mode === 'disconnect') client.socket.close()
    if (mode === 'shutdown') await bridge.close()
    await abort
    await client.close
    assert.deepEqual(client.messages, [])
  }
})

test('duplicate, older and concurrent turns are rejected instead of interrupting inference', async (t) => {
  for (const eventId of [1, 0, 2]) {
    let aborted
    const abort = new Promise((resolve) => { aborted = resolve })
    const { connect, admission } = await fixture(t, waitingProvider(aborted))
    admission.register('conv_1')
    const client = await connect()
    client.send(transcript(1)); client.send(transcript(eventId))
    assert.equal((await client.close).code, 1008)
    await abort
  }
})

for (const [name, message, binary] of [
  ['binary', Buffer.from('hello'), true], ['malformed JSON', '{', false],
  ['unsupported role', { ...transcript(), user_transcript: [{ role: 'system', content: 'secret' }] }],
  ['oversized content', transcript(1, 'a'.repeat(32 * 1024 + 1))],
  ['noninteger event', transcript(1.5)], ['empty history', { ...transcript(), user_transcript: [] }],
  ['oversized frame', 'a'.repeat(256 * 1024 + 1), false],
]) test(`rejects ${name} before inference`, async (t) => {
  let calls = 0
  const { connect, admission } = await fixture(t, async function* () { calls++; yield { type: 'done' } })
  admission.register('conv_1')
  const client = await connect()
  client.socket.send(typeof message === 'object' && !binary ? JSON.stringify(message) : message, { binary: !!binary })
  const result = await client.close
  assert.equal(result.code, name === 'oversized frame' ? 1009 : 1008)
  assert.equal(calls, 0)
})

test('initialization, idle and session-count limits are enforced on real sockets', async (t) => {
  const { connect, admission } = await fixture(t, undefined, { initTimeoutMs: 20, idleTimeoutMs: 60, maxSessions: 1 })
  const initial = await connect(null)
  assert.equal((await connect(null)).opened, 503)
  assert.equal((await initial.close).code, 1008)
  admission.register('conv_1')
  const idle = await connect()
  assert.equal((await idle.close).code, 1008)
})
