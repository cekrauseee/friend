import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import OpenAI from 'openai'
import { createLiveApi } from '../server/live-api.ts'

async function request(handler, { origin = 'http://localhost:5173', body = { sdp: 'v=0\r\no=browser' } } = {}) {
  const req = Readable.from([JSON.stringify(body)])
  req.method = 'POST'
  req.headers = { origin, host: 'localhost:5173', 'content-type': 'application/json' }
  const res = new EventEmitter()
  res.setHeader = () => {}
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = JSON.parse(body); res.writableEnded = true }
  await handler(req, res)
  return res
}

test('the server fixes model settings and returns only the connection answer', async () => {
  let sent
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (_url, init) => {
    sent = JSON.parse(init.body)
    return Response.json({ session: { id: 'live_test', internal: 'private' }, transport: { type: 'webrtc', sdp: 'answer' } })
  } })
  const result = await request(createLiveApi(undefined, client), {
    body: { sdp: 'v=0\r\no=browser', model: 'another-model', tools: [{ type: 'web_search' }] },
  })
  assert.equal(sent.session.model, 'gpt-live-1')
  assert.equal(sent.session.delegation.responses.model, 'gpt-6-luna')
  assert.equal(sent.session.delegation.responses.reasoning.effort, 'none')
  assert.equal(sent.session.delegation.responses.tool_choice, 'none')
  assert.deepEqual(sent.session.delegation.responses.tools, [])
  assert.equal(result.status, 201)
  assert.deepEqual(result.body, { session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'answer' } })
  assert.equal(result.headers['Cache-Control'], 'no-store')
})

test('missing configuration, cross-origin requests, and invalid offers do not call OpenAI', async () => {
  let calls = 0
  const client = new OpenAI({ apiKey: 'test-only', fetch: async () => { calls++; throw new Error('Unexpected call') } })
  assert.equal((await request(createLiveApi(undefined))).status, 503)
  assert.equal((await request(createLiveApi(undefined, client), { origin: 'https://another-site.example' })).status, 403)
  assert.equal((await request(createLiveApi(undefined, client), { body: { sdp: '' } })).status, 400)
  assert.equal(calls, 0)
})

test('OpenAI authentication failures are actionable without exposing upstream details', async () => {
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async () =>
    Response.json({ error: { message: 'Private upstream account details', type: 'authentication_error' } }, { status: 401 }) })
  const result = await request(createLiveApi(undefined, client))
  assert.equal(result.status, 503)
  assert.equal(result.body.error, 'OpenAI access is not configured correctly.')
  assert.ok(!JSON.stringify(result.body).includes('Private upstream'))
})
