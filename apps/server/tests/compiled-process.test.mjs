import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createHash, createHmac } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const origin = 'http://localhost:5173'
const key = 'synthetic-elevenlabs-key'
async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function jwt() {
  const encoded = [{ alg: 'HS256' }, { iss: 'https://api.elevenlabs.io/convai/speech-engine',
    sub: 'convai_speech_engine_upstream', exp: Date.now() / 1000 + 60 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')
  return `${encoded}.${createHmac('sha256', createHash('sha256').update(key).digest()).update(encoded).digest('base64url')}`
}
function inbox(emitter, name, decode = value => value) {
  const queue = []
  let wake
  emitter.on(name, value => { queue.push(decode(value)); wake?.(); wake = undefined })
  return async predicate => {
    for (;;) {
      const index = queue.findIndex(predicate ?? (() => true))
      if (index >= 0) return queue.splice(index, 1)[0]
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}.`)), 5000)
        wake = () => { clearTimeout(timer); resolve() }
      })
    }
  }
}
async function fixture(t, speech = false) {
  const root = await mkdtemp(join(tmpdir(), 'dot-compiled-process-'))
  const app = join(root, 'apps/server')
  await mkdir(app, { recursive: true })
  await cp(new URL('../dist/', import.meta.url), join(app, 'dist'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  // Only server dependencies are available. No web app, Vite or web env is copied.
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(app, 'node_modules'))
  const port = await unusedPort()
  const speechPort = await unusedPort()
  await writeFile(join(root, '.env.local'), speech
    ? `OPENAI_API_KEY=synthetic-openai-key\nELEVENLABS_API_KEY=${key}\nELEVENLABS_SPEECH_ENGINE_ID=seng_test\nDOT_VOICE_PROVIDER=elevenlabs\nDOT_TRANSCRIPTION_PROVIDER=elevenlabs\nDOT_SPEECH_ENGINE_PORT=${speechPort}\nDOT_API_PORT=1\n`
    : 'OPENAI_API_KEY=\nDOT_TEXT_PROVIDER=\nDOT_API_PORT=1\n')
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/mock-providers.mjs', import.meta.url)), join(app, 'dist/index.js')], {
    cwd: tmpdir(), env: { PATH: process.env.PATH, DOT_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const exited = once(child, 'exit')
  const messages = inbox(child, 'message')
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend did not start: ${output}`)), 5000)
      const ready = () => {
        if (output.includes('HTTP API listening')) { clearTimeout(timer); child.stdout.off('data', ready); resolve() }
      }
      child.stdout.on('data', ready)
    }),
    exited.then(() => { throw new Error(`Backend exited before readiness: ${output}`) }),
  ])
  return { child, exited, messages, port, speechPort, base: `http://127.0.0.1:${port}`, output: () => output }
}
function call(base, path, { method = 'POST', headers = {}, body } = {}) {
  return fetch(base + path, { method, headers: { Origin: origin, ...headers }, body })
}
async function release(port) {
  const server = createServer()
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  await new Promise(resolve => server.close(resolve))
}

test('compiled backend boots without web or credentials from unrelated cwd and preserves HTTP policies', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  assert.deepEqual(await (await fetch(f.base + '/api/health')).json(), { ready: true })
  assert.equal((await fetch(f.base + '/api/voice-provider')).status, 403)
  const discovery = await fetch(f.base + '/api/voice-provider', { headers: { 'Sec-Fetch-Site': 'same-origin' } })
  assert.equal(discovery.status, 503)
  assert.deepEqual(await discovery.json(), { error: 'OpenAI voice requires OPENAI_API_KEY on the server.' })
  assert.equal((await call(f.base, '/api/chat', { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await call(f.base, '/api/chat', { headers: { Origin: 'https://evil.example' } })).status, 403)
  const preflight = await call(f.base, '/api/chat', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin)
  const access = await call(f.base, '/api/text-access/status')
  assert.equal(access.status, 200)
  assert.equal((await access.json()).provider, 'api')
  assert.equal((await call(f.base, '/api/text-access/login')).status, 403)
  const chat = await call(f.base, '/api/chat', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }) })
  assert.equal(chat.status, 503)
  assert.equal((await chat.json()).error.code, 'not_configured')
  f.child.kill('SIGTERM')
  assert.deepEqual(await f.exited, [0, null])
  await release(f.port)
  assert.doesNotMatch(f.output(), /synthetic-openai-key|synthetic-elevenlabs-key/)
})

test('compiled Hono runtime streams, aborts, admits independent authenticated speech sessions and shuts down', { timeout: 20000 }, async t => {
  const f = await fixture(t, true)
  const history = [{ role: 'user', content: 'Text' }]
  const response = await call(f.base, '/api/chat', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history }) })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value).trim()), { type: 'delta', text: 'Shared reply' })
  const rest = await reader.read()
  assert.deepEqual(JSON.parse(new TextDecoder().decode(rest.value).trim()), { type: 'done' })
  assert.deepEqual((await f.messages(message => message.type === 'inference')).input, history)

  const pending = request(f.base + '/api/chat', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } })
  pending.end(JSON.stringify({ messages: [{ role: 'user', content: 'Paused' }] }))
  const [stream] = await once(pending, 'response')
  await once(stream, 'data')
  stream.destroy()
  await f.messages(message => message.type === 'aborted')
  await f.messages(message => message.type === 'inference')

  const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3])
  const transcription = await call(f.base, '/api/transcription', { headers: { 'Content-Type': 'audio/webm' }, body: audio })
  assert.equal(transcription.status, 200)
  assert.deepEqual(await transcription.json(), { text: 'Synthetic words' })
  assert.deepEqual((await f.messages(message => message.type === 'audio')).bytes, [...audio])
  const oversized = request(f.base + '/api/transcription', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/webm', 'Content-Length': '25000001' } })
  oversized.flushHeaders()
  const [rejected] = await once(oversized, 'response')
  assert.equal(rejected.statusCode, 413)
  rejected.resume(); oversized.destroy()

  const upstream = `http://127.0.0.1:${f.speechPort}`
  assert.equal((await fetch(upstream + '/api/chat')).status, 404)
  const sockets = []
  t.after(() => sockets.forEach(socket => socket.terminate()))
  for (let index = 1; index <= 2; index++) {
    const token = await call(f.base, '/api/elevenlabs-session')
    assert.equal(token.status, 201)
    assert.deepEqual(await token.json(), { provider: 'elevenlabs', model: 'eleven_v4_turbo', conversationToken: 'short-lived-token' })
    const socket = new WebSocket(`ws://127.0.0.1:${f.speechPort}/speech-engine/upstream`, { headers: { 'X-Elevenlabs-Speech-Engine-Authorization': jwt() } })
    sockets.push(socket)
    const next = inbox(socket, 'message', value => JSON.parse(value))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'init', conversation_id: `conv_process_${index}` }))
    const messages = [{ role: 'user', content: `Voice ${index}` }]
    socket.send(JSON.stringify({ type: 'user_transcript', event_id: 1, user_transcript: messages }))
    assert.deepEqual(await next(), { type: 'agent_response', event_id: 1, content: 'Shared reply', is_final: false })
    assert.deepEqual(await next(), { type: 'agent_response', event_id: 1, content: '', is_final: true })
    assert.deepEqual((await f.messages(message => message.type === 'inference')).input, messages)
  }
  // Admissions are one-shot, even while the original session is connected.
  const duplicate = new WebSocket(`ws://127.0.0.1:${f.speechPort}/speech-engine/upstream`, { headers: { 'X-Elevenlabs-Speech-Engine-Authorization': jwt() } })
  sockets.push(duplicate)
  await once(duplicate, 'open')
  const duplicateClosed = once(duplicate, 'close')
  duplicate.send(JSON.stringify({ type: 'init', conversation_id: 'conv_process_1' }))
  await duplicateClosed
  const next = inbox(sockets[0], 'message', value => JSON.parse(value))
  sockets[0].send(JSON.stringify({ type: 'user_transcript', event_id: 2, user_transcript: [{ role: 'user', content: 'Paused' }] }))
  assert.equal((await next()).content, 'Shared reply')
  const closed = sockets.slice(0, 2).map(socket => once(socket, 'close'))
  f.child.kill('SIGTERM')
  await f.messages(message => message.type === 'aborted')
  await Promise.all(closed)
  assert.deepEqual(await f.exited, [0, null])
  await release(f.port)
  await release(f.speechPort)
  assert.doesNotMatch(f.output(), /synthetic-openai-key|synthetic-elevenlabs-key/)
})
