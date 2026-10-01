import assert from 'node:assert/strict'
import { test } from 'node:test'
import config, { createApiProxy } from '../vite.config.ts'

test('development and preview proxy API requests to the independent server', () => {
  const saved = process.env.API_PROXY_TARGET
  try {
    delete process.env.API_PROXY_TARGET
    const defaults = config({ mode: 'test', command: 'serve' })
    assert.deepEqual(defaults.server.proxy, { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } })
    assert.deepEqual(defaults.preview.proxy, defaults.server.proxy)
    process.env.API_PROXY_TARGET = 'http://localhost:4567/'
    const custom = config({ mode: 'test', command: 'serve', isPreview: true })
    assert.deepEqual(custom.server.proxy, { '/api': { target: 'http://localhost:4567', changeOrigin: false } })
    assert.deepEqual(custom.preview.proxy, custom.server.proxy)
  } finally {
    if (saved === undefined) delete process.env.API_PROXY_TARGET
    else process.env.API_PROXY_TARGET = saved
  }
})

test('proxy targets are HTTP origins and preserve API paths and browser origins', () => {
  assert.deepEqual(createApiProxy('https://api.example.test'), { '/api': { target: 'https://api.example.test', changeOrigin: false } })
  for (const target of ['/api', 'ws://localhost:3000', 'http://user:secret@localhost:3000',
    'http://localhost:3000/api', 'http://localhost:3000?private=1', 'http://localhost:3000/#fragment', 'http://localhost:3000?', 'http://localhost:3000#']) {
    assert.throws(() => createApiProxy(target))
  }
})
