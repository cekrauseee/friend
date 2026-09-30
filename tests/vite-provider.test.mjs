import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { liveApiPlugin } from '../server/vite-plugin.ts'

test('Codex is development-only; explicit Codex selection never falls back to API in preview', async () => {
  const envDir = await mkdtemp(join(tmpdir(), 'friend-vite-test-'))
  const saved = process.env.FRIEND_TEXT_PROVIDER
  try {
    process.env.FRIEND_TEXT_PROVIDER = 'codex'
    const preview = liveApiPlugin()
    preview.config({}, { command: 'serve', mode: 'production', isPreview: true })
    assert.throws(() => preview.configResolved({ mode: 'production', command: 'serve', envDir }), /requires pnpm dev/)
    process.env.FRIEND_TEXT_PROVIDER = 'api'
    const api = liveApiPlugin()
    api.config({}, { command: 'serve', mode: 'production', isPreview: true })
    api.configResolved({ mode: 'production', command: 'serve', envDir })
    const routes = []
    api.configurePreviewServer({ middlewares: { use: (path) => routes.push(path) } })
    assert.deepEqual(routes, ['/api/text-access', '/api/session', '/api/chat'])
    process.env.FRIEND_TEXT_PROVIDER = 'codex'
    const dev = liveApiPlugin()
    dev.config({}, { command: 'serve', mode: 'development', isPreview: false })
    dev.configResolved({ mode: 'development', command: 'serve', envDir })
    dev.closeBundle()
  } finally {
    if (saved === undefined) delete process.env.FRIEND_TEXT_PROVIDER
    else process.env.FRIEND_TEXT_PROVIDER = saved
    await rm(envDir, { recursive: true, force: true })
  }
})
