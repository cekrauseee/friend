import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { liveApiPlugin } from '../server/vite-plugin.ts'

test('Codex is development-only; explicit Codex selection never falls back to API in preview', async () => {
  const envDir = await mkdtemp(join(tmpdir(), 'dot-vite-test-'))
  const saved = process.env.DOT_TEXT_PROVIDER
  try {
    process.env.DOT_TEXT_PROVIDER = 'codex'
    const preview = liveApiPlugin()
    preview.config({}, { command: 'serve', mode: 'production', isPreview: true })
    assert.throws(() => preview.configResolved({ mode: 'production', command: 'serve', envDir }), /requires pnpm dev/)
    process.env.DOT_TEXT_PROVIDER = 'api'
    const api = liveApiPlugin()
    api.config({}, { command: 'serve', mode: 'production', isPreview: true })
    api.configResolved({ mode: 'production', command: 'serve', envDir })
    const routes = []
    api.configurePreviewServer({ middlewares: { use: (path) => routes.push(path) } })
    assert.deepEqual(routes, ['/api/text-access', '/api/voice-provider', '/api/elevenlabs-session', '/api/session', '/api/chat', '/api/transcription'])
    process.env.DOT_TEXT_PROVIDER = 'codex'
    const dev = liveApiPlugin()
    dev.config({}, { command: 'serve', mode: 'development', isPreview: false })
    dev.configResolved({ mode: 'development', command: 'serve', envDir })
    const developmentRoutes = []
    dev.configureServer({ middlewares: { use: (path) => developmentRoutes.push(path) } })
    assert.deepEqual(developmentRoutes, routes)
    dev.closeBundle()
  } finally {
    if (saved === undefined) delete process.env.DOT_TEXT_PROVIDER
    else process.env.DOT_TEXT_PROVIDER = saved
    await rm(envDir, { recursive: true, force: true })
  }
})

async function transcriptionEnvironment(values, run, file = '') {
  const keys = ['DOT_TRANSCRIPTION_PROVIDER', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY',
    'DOT_TEXT_PROVIDER', 'DOT_VOICE_PROVIDER']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const envDir = await mkdtemp(join(tmpdir(), 'dot-transcription-test-'))
  try {
    for (const key of keys) delete process.env[key]
    process.env.DOT_TEXT_PROVIDER = 'api'
    Object.assign(process.env, values)
    await writeFile(join(envDir, '.env'), file)
    await run(envDir)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await rm(envDir, { recursive: true, force: true })
  }
}

function mountedTranscription(envDir, preview) {
  const plugin = liveApiPlugin()
  const mode = preview ? 'production' : 'development'
  plugin.config({}, { command: 'serve', mode, isPreview: preview })
  plugin.configResolved({ mode, command: 'serve', envDir })
  const routes = new Map()
  const server = { middlewares: { use: (path, handler) => routes.set(path, handler) } }
  if (preview) plugin.configurePreviewServer(server)
  else plugin.configureServer(server)
  assert.deepEqual([...routes.keys()], ['/api/text-access', '/api/voice-provider', '/api/elevenlabs-session', '/api/session', '/api/chat', '/api/transcription'])
  plugin.closeBundle()
  return routes.get('/api/transcription')
}

async function transcribe(handler) {
  const req = Readable.from([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x01])])
  req.method = 'POST'
  req.headers = { origin: 'http://localhost:5173', host: 'localhost:5173', 'content-type': 'audio/webm' }
  const res = new EventEmitter()
  res.destroyed = false
  res.writableEnded = false
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = JSON.parse(body); res.writableEnded = true }
  await handler(req, res)
  return res
}

test('development and preview independently select default OpenAI, explicit OpenAI and ElevenLabs', async () => {
  for (const preview of [false, true]) {
    for (const provider of [undefined, 'openai', 'elevenlabs']) {
      const elevenlabs = provider === 'elevenlabs'
      const values = {
        [elevenlabs ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY']: 'test-only',
        DOT_VOICE_PROVIDER: elevenlabs ? 'openai' : 'elevenlabs',
        ...(provider === undefined ? {} : { DOT_TRANSCRIPTION_PROVIDER: provider }),
      }
      await transcriptionEnvironment(values, async (envDir) => {
        let calls = 0
        globalThis.fetch = async (url, init) => {
          if (url === 'data:,') return new Response('') // SDK checks native FormData support.
          calls++
          assert.equal(url.toString(), elevenlabs
            ? 'https://api.elevenlabs.io/v1/speech-to-text' : 'https://api.openai.com/v1/audio/transcriptions')
          assert.equal(init.body.get(elevenlabs ? 'model_id' : 'model'), elevenlabs ? 'scribe_v2' : 'gpt-transcribe')
          return Response.json({ text: '  Selected provider  ' })
        }
        const res = await transcribe(mountedTranscription(envDir, preview))
        assert.equal(res.status, 200)
        assert.deepEqual(res.body, { text: 'Selected provider' })
        assert.equal(calls, 1)
      })
    }
  }
})

test('selected transcription key is required and another configured provider never supplies a fallback', async () => {
  for (const provider of ['openai', 'elevenlabs']) {
    await transcriptionEnvironment({ DOT_TRANSCRIPTION_PROVIDER: provider,
      [provider === 'elevenlabs' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY']: 'test-only' }, async (envDir) => {
      globalThis.fetch = async () => { assert.fail('Missing selected key must not call any provider') }
      for (const preview of [false, true]) {
        const res = await transcribe(mountedTranscription(envDir, preview))
        assert.equal(res.status, 503)
        assert.equal(res.body.error.code, 'not_configured')
        assert.match(res.body.error.message, provider === 'elevenlabs' ? /ElevenLabs API key/ : /OpenAI API key/)
      }
    })
  }
})

test('ElevenLabs dictation also works alongside Codex text selection without an OpenAI key', async () => {
  await transcriptionEnvironment({ DOT_TEXT_PROVIDER: 'codex', DOT_TRANSCRIPTION_PROVIDER: 'elevenlabs',
    ELEVENLABS_API_KEY: 'test-only' }, async (envDir) => {
    let calls = 0
    globalThis.fetch = async (url) => {
      calls++
      assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text')
      return Response.json({ text: 'Independent dictation' })
    }
    const res = await transcribe(mountedTranscription(envDir, false))
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
  })
})

test('unknown and blank transcription selections fail at startup in development and preview', async () => {
  for (const provider of ['other', '', ' ', 'OpenAI']) {
    await transcriptionEnvironment({ DOT_TRANSCRIPTION_PROVIDER: provider }, async (envDir) => {
      for (const preview of [false, true]) {
        assert.throws(() => mountedTranscription(envDir, preview), /DOT_TRANSCRIPTION_PROVIDER must be openai or elevenlabs/)
      }
    })
  }
})

test('transcription selection loads local environment files and process values take precedence', async () => {
  const file = 'DOT_TRANSCRIPTION_PROVIDER=elevenlabs\nELEVENLABS_API_KEY=file-test-only\n'
  await transcriptionEnvironment({}, async (envDir) => {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text')
      assert.equal(init.headers['xi-api-key'], 'file-test-only')
      return Response.json({ text: 'From local file' })
    }
    assert.equal((await transcribe(mountedTranscription(envDir, true))).status, 200)
  }, file)
  await transcriptionEnvironment({ ELEVENLABS_API_KEY: 'process-test-only' }, async (envDir) => {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers['xi-api-key'], 'process-test-only')
      return Response.json({ text: 'From process' })
    }
    assert.equal((await transcribe(mountedTranscription(envDir, false))).status, 200)
  }, file)
  await transcriptionEnvironment({ DOT_TRANSCRIPTION_PROVIDER: 'openai' }, async (envDir) => {
    globalThis.fetch = async () => { assert.fail('OpenAI selection must not fall back to the file ElevenLabs key') }
    const res = await transcribe(mountedTranscription(envDir, true))
    assert.equal(res.body.error.code, 'not_configured')
    assert.match(res.body.error.message, /OpenAI API key/)
  }, file)
})

test('Vite independently selects voice and rejects invalid voice configuration in dev and preview', async () => {
  const envDir = await mkdtemp(join(tmpdir(), 'dot-voice-config-'))
  await writeFile(join(envDir, '.env'), 'ELEVENLABS_API_KEY=test-only\nELEVENLABS_AGENT_ID=agent_test\n')
  const savedVoice = process.env.DOT_VOICE_PROVIDER
  const savedText = process.env.DOT_TEXT_PROVIDER
  try {
    process.env.DOT_TEXT_PROVIDER = 'api'
    for (const isPreview of [false, true]) {
      const config = { mode: isPreview ? 'production' : 'development', command: 'serve', envDir }
      process.env.DOT_VOICE_PROVIDER = 'invalid'
      const invalid = liveApiPlugin()
      invalid.config({}, { ...config, isPreview })
      assert.throws(() => invalid.configResolved(config), /DOT_VOICE_PROVIDER must be openai or elevenlabs/)
      process.env.DOT_VOICE_PROVIDER = 'elevenlabs'
      const plugin = liveApiPlugin()
      plugin.config({}, { ...config, isPreview })
      plugin.configResolved(config)
      const routes = new Map()
      plugin[isPreview ? 'configurePreviewServer' : 'configureServer']({ middlewares: { use: (path, handler) => routes.set(path, handler) } })
      let body
      await routes.get('/api/voice-provider')({ method: 'GET', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } }, {
        writeHead() {}, end(value) { body = JSON.parse(value) },
      })
      assert.deepEqual(body, { provider: 'elevenlabs' })
    }
  } finally {
    if (savedVoice === undefined) delete process.env.DOT_VOICE_PROVIDER
    else process.env.DOT_VOICE_PROVIDER = savedVoice
    if (savedText === undefined) delete process.env.DOT_TEXT_PROVIDER
    else process.env.DOT_TEXT_PROVIDER = savedText
    await rm(envDir, { recursive: true, force: true })
  }
})
