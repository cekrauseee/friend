import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { loadServerConfig, repositoryRoot } from '../src/config.ts'
import { createRuntime } from '../src/runtime.ts'
import { createBackendServer } from '../src/server.ts'

const config = env => loadServerConfig({ mode: 'production', root: '/nonexistent', env })
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('root env files preserve quoted, empty and multiline values with process precedence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dot-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=base\nDOT_TEXT_PROVIDER=api\n')
  await writeFile(join(root, '.env.local'), 'OPENAI_API_KEY="local # quoted"\nELEVENLABS_API_KEY="line one\nline two"\n')
  assert.equal(config({}).port, 3000)
  const file = loadServerConfig({ root, mode: 'development', env: {} })
  assert.equal(file.openaiApiKey, 'local # quoted')
  assert.equal(file.elevenlabsApiKey, 'line one\nline two')
  assert.equal(file.textProvider, 'api')
  const process = loadServerConfig({ root, mode: 'development', env: { OPENAI_API_KEY: '', ELEVENLABS_API_KEY: 'process' } })
  assert.equal(process.openaiApiKey, '')
  assert.equal(process.elevenlabsApiKey, 'process')
  assert.equal(repositoryRoot, new URL('../../../', import.meta.url).pathname)
})

test('invalid runtime options fail safely and origin defaults are exact local origins', () => {
  for (const env of [{ DOT_API_HOST: 'example.com' }, { DOT_API_PORT: '0' }, { DOT_API_PORT: '65536' },
    { DOT_FRONTEND_ORIGINS: '*' }, { DOT_FRONTEND_ORIGINS: 'null' }, { DOT_FRONTEND_ORIGINS: 'https://user:password@example.com' },
    { DOT_FRONTEND_ORIGINS: 'https://example.com/path' }, { DOT_FRONTEND_ORIGINS: '' }, { DOT_SERVER_MODE: 'preview' }]) {
    assert.throws(() => loadServerConfig({ root: '/nonexistent', env }))
  }
  assert.deepEqual(config({}).frontendOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173'])
})

test('selected cognition is constructed once, shared with speech, and shutdown aborts active turns', async () => {
  let count = 0
  let speechProvider
  let signal
  let speechClosed = 0
  const runtime = createRuntime(config({ DOT_VOICE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'test-only' }), {
    createApiChatProvider() {
      count++
      return async function* (_messages, turnSignal) {
        signal = turnSignal
        yield { type: 'delta', text: 'Pending' }
        await new Promise(resolve => turnSignal.addEventListener('abort', resolve, { once: true }))
      }
    },
    createSpeechEngineServer(options) {
      speechProvider = options.provider
      return { server: { listening: false }, listen: async () => {}, close: async () => { speechClosed++ } }
    },
  })
  assert.equal(count, 1)
  assert.equal(speechProvider, runtime.provider)
  const iterator = runtime.provider([{ role: 'user', content: 'hello' }], new AbortController().signal)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.text, 'Pending')
  const pending = iterator.next()
  runtime.admission.register('conv_pending')
  await runtime.close()
  await pending
  assert.equal(signal.aborted, true)
  assert.equal(runtime.admission.consume('conv_pending'), false)
  await runtime.close()
  assert.equal(speechClosed, 1)
  assert.equal((await runtime.provider([], new AbortController().signal)[Symbol.asyncIterator]().next()).done, true)
})

test('Codex is selected once without API fallback and is released after construction failure', async () => {
  let closed = 0
  let count = 0
  const codex = { chat: async function* () {}, status: async () => true, startLogin: async () => ({}), cancelLogin: async () => {}, close: () => { closed++ } }
  const factories = { createCodexProvider: () => { count++; return codex }, createApiChatProvider: () => assert.fail('No fallback') }
  const dev = loadServerConfig({ mode: 'development', root: '/nonexistent', env: {} })
  const runtime = createRuntime(dev, factories)
  await runtime.close()
  assert.equal(count, 1)
  assert.equal(closed, 1)
  assert.throws(() => createRuntime({ ...dev, voiceProvider: 'elevenlabs', elevenlabsApiKey: 'test-only', speechAddress: { port: 3001 } }, {
    ...factories, createSpeechEngineServer: () => { throw new Error('construction failure') },
  }), /construction failure/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 2)
})

test('HTTP health boots without credentials and close releases the port', async () => {
  const runtime = createRuntime(config({}))
  const app = new Hono().get('/api/health', c => c.json({ ok: true }))
  const backend = createBackendServer({ ...config({}), port: 0 }, runtime, app.fetch)
  await backend.listen()
  const port = backend.server.address().port
  const response = await fetch(`http://127.0.0.1:${port}/api/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  await backend.close()
  await backend.close()
  await assert.rejects(backend.listen(), /closed/)
  const replacement = createServer()
  replacement.listen(port, '127.0.0.1')
  await once(replacement, 'listening')
  await new Promise(resolve => replacement.close(resolve))
})

test('HTTP bind failure unwinds the Speech listener and closes Codex', async t => {
  const occupied = createServer()
  const port = await listen(occupied)
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  let closed = 0
  const selected = loadServerConfig({ mode: 'development', root: '/nonexistent', env: { DOT_VOICE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'test-only' } })
  const runtime = createRuntime({ ...selected, speechAddress: { host: '127.0.0.1', port: 0 } }, {
    createCodexProvider: () => ({ chat: async function* () {}, close: () => { closed++ } }),
  })
  const backend = createBackendServer({ ...selected, port }, runtime, new Hono().fetch)
  await assert.rejects(backend.listen(), /HTTP API port is in use/)
  assert.equal(runtime.speech.server.listening, false)
  assert.equal(closed, 1)
  await backend.close()
})

test('Speech bind failure never starts HTTP and cleanup remains idempotent', async t => {
  const occupied = createServer()
  const port = await listen(occupied)
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  const selected = config({ DOT_VOICE_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'test-only', DOT_SPEECH_ENGINE_PORT: `${port}` })
  const runtime = createRuntime(selected)
  const backend = createBackendServer({ ...selected, port: 0 }, runtime, new Hono().fetch)
  await assert.rejects(backend.listen(), /Speech Engine upstream port is in use/)
  assert.equal(backend.server.listening, false)
  await backend.close()
})
