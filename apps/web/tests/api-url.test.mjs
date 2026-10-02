import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiPaths } from '@dot/contracts'
import { apiUrl, createApiUrl } from '../src/lib/api-url.ts'

const paths = Object.values(apiPaths).flatMap((value) => typeof value === 'string' ? [value] : Object.values(value))

test('default browser URLs retain every relative API contract path', () => {
  for (const path of paths) {
    assert.equal(apiUrl(path), path)
    assert.equal(createApiUrl('  ')(path), path)
  }
})

test('configured origins and path prefixes join all API paths with one slash', () => {
  for (const base of ['https://api.example.test', 'https://api.example.test/', ' https://api.example.test/// ']) {
    for (const path of paths) assert.equal(createApiUrl(base)(path), `https://api.example.test${path}`)
  }
  assert.equal(createApiUrl('http://localhost:3000/gateway///')(apiPaths.chat), 'http://localhost:3000/gateway/api/chat')
})

test('configured bases reject relative URLs, other schemes and credential/query/fragment URLs', () => {
  for (const base of ['/gateway', '//api.example.test', 'file:///tmp', 'javascript:alert(1)',
    'https://name:secret@api.example.test', 'https://api.example.test?token=private', 'https://api.example.test/#fragment', 'https://api.example.test?', 'https://api.example.test#']) {
    assert.throws(() => createApiUrl(base), /VITE_API_BASE_URL/)
  }
})
