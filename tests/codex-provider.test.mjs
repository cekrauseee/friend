import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createCodexProvider, createTextAccessApi, validAuthUrl } from '../server/codex-provider.ts'
import { createChatApi } from '../server/chat-api.ts'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const messages = [{ role: 'user', content: 'Hi' }]
function fixture(overrides = {}, options) {
  const listeners = new Set()
  const calls = []
  let authenticated = true
  const rpc = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(method, params = {}) { for (const fn of listeners) fn({ method, params }) },
    close() {},
    async request(method, params) {
      calls.push({ method, params })
      if (overrides[method]) return overrides[method](params, rpc)
      if (method === 'account/read') return { account: authenticated ? { type: 'chatgpt', email: 'private@example.org' } : null }
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?private=token' }
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-6-luna', reasoningEffort: 'none' }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          rpc.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello' })
          rpc.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    },
  }
  return { rpc, calls, provider: createCodexProvider(rpc, options), setAuth(value) { authenticated = value } }
}
async function collect(provider, signal = new AbortController().signal) {
  return Array.fromAsync(provider.chat(messages, signal))
}
async function request(handler, url, origin = 'http://localhost:5173', body) {
  const req = Readable.from(body ? [JSON.stringify(body)] : [])
  req.method = 'POST'; req.url = url
  req.headers = { origin, host: 'localhost:5173', 'content-type': 'application/json' }
  const res = new EventEmitter()
  res.destroyed = false; res.writableEnded = false; res.chunks = []
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.write = (s) => { res.chunks.push(s); return true }
  res.end = (s) => { if (s) res.chunks.push(s); res.writableEnded = true }
  await handler(req, res)
  res.text = res.chunks.join('')
  return res
}

test('fixed Codex settings, isolated thread, accepted history and ordered streaming', async () => {
  const { provider, calls } = fixture()
  assert.deepEqual(await collect(provider), [{ type: 'delta', text: 'Hello' }, { type: 'done' }])
  const thread = calls.find((c) => c.method === 'thread/start').params
  assert.equal(thread.model, 'gpt-6-luna'); assert.equal(thread.ephemeral, true)
  assert.equal(thread.allowProviderModelFallback, false)
  assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.sandbox, 'read-only')
  assert.deepEqual(thread.environments, []); assert.deepEqual(thread.dynamicTools, [])
  assert.deepEqual(thread.runtimeWorkspaceRoots, [])
  const turn = calls.find((c) => c.method === 'turn/start').params
  assert.equal(turn.model, 'gpt-6-luna'); assert.equal(turn.effort, 'none')
  assert.deepEqual(turn.environments, [])
  assert.deepEqual(JSON.parse(turn.input[0].text), messages)
  assert.equal(calls.at(-1).method, 'thread/unsubscribe')
  provider.close()
})

test('signed-out and API-key accounts cannot infer; model substitution fails closed', async () => {
  for (const account of [null, { type: 'apiKey' }]) {
    const { provider, calls } = fixture({ 'account/read': () => ({ account }) })
    await assert.rejects(collect(provider), { code: 'access_denied' })
    assert.equal(calls.some((c) => c.method === 'thread/start'), false)
    provider.close()
  }
  const { provider } = fixture({ 'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'other', reasoningEffort: 'none' }) })
  await assert.rejects(collect(provider), { code: 'upstream_error' })
  provider.close()
})

test('failure, interruption, empty completion, rejected request and process crash never succeed', async () => {
  for (const failure of ['failed', 'interrupted', 'empty', 'dot/process/error', 'dot/request/rejected']) {
    const { provider } = fixture({ 'turn/start': (_params, rpc) => {
      queueMicrotask(() => {
        if (failure !== 'empty') rpc.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'Partial' })
        if (failure.startsWith('dot/')) rpc.emit(failure, { threadId: 'thread-1' })
        else rpc.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: failure === 'empty' ? 'completed' : failure } })
      })
      return { turn: { id: 'turn-1' } }
    } })
    await assert.rejects(collect(provider), { code: 'upstream_error' })
    provider.close()
  }
})

test('client abort and response deadline interrupt running turns', async () => {
  for (const timeout of [false, true]) {
    const abort = new AbortController()
    const { provider, calls } = fixture({ 'turn/start': (_params, rpc) => {
      queueMicrotask(() => rpc.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'First' }))
      return { turn: { id: 'turn-1' } }
    } }, { turnTimeoutMs: timeout ? 5 : 1000 })
    const events = []
    const run = async () => { for await (const e of provider.chat(messages, abort.signal)) { events.push(e); if (!timeout) abort.abort() } }
    if (timeout) await assert.rejects(run(), { code: 'upstream_error' })
    else await run()
    assert.deepEqual(events, [{ type: 'delta', text: 'First' }])
    assert.ok(calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'turn-1'))
    provider.close()
  }
})

test('login notifications, refusal, timeout, cancel and retry have terminal status without tokens', async () => {
  const f = fixture({}, { loginTimeoutMs: 10 })
  f.setAuth(false)
  await f.provider.startLogin()
  f.rpc.emit('account/login/completed', { loginId: 'other', success: true })
  assert.equal((await f.provider.status()).login.state, 'pending')
  f.rpc.emit('account/login/completed', { loginId: 'login-1', success: false, error: 'private token' })
  assert.equal((await f.provider.status()).login.state, 'failed')
  assert.ok(!JSON.stringify(await f.provider.status()).includes('token'))
  await f.provider.startLogin(); f.setAuth(true)
  f.rpc.emit('account/updated', { authMode: 'chatgpt' }); await tick()
  assert.equal((await f.provider.status()).login.state, 'succeeded')
  assert.ok(!JSON.stringify(await f.provider.status()).includes('private@example'))
  f.setAuth(false); await f.provider.startLogin(); await f.provider.cancelLogin()
  assert.equal((await f.provider.status()).login.state, 'failed')
  await f.provider.startLogin(); await new Promise((r) => setTimeout(r, 15))
  assert.equal((await f.provider.status()).login.state, 'failed')
  await f.provider.startLogin(); f.rpc.emit('dot/process/error')
  assert.equal((await f.provider.status()).login.state, 'failed')
  f.provider.close()
})

test('auth URL allowlist rejects credentials, ports and lookalike hosts', async () => {
  for (const url of ['http://auth.openai.com/x', 'https://auth.openai.com.evil.test', 'https://evil@chatgpt.com/x', 'https://chatgpt.com:444/x', 'javascript:alert(1)', null]) assert.equal(validAuthUrl(url), false)
  assert.equal(validAuthUrl('https://chatgpt.com/auth/login'), true)
  const { provider, calls } = fixture({ 'account/login/start': () => ({ type: 'chatgpt', loginId: 'bad', authUrl: 'https://evil.test' }) })
  await assert.rejects(provider.startLogin())
  assert.ok(calls.some((c) => c.method === 'account/login/cancel'))
  provider.close()
})

test('auth routes require local same-origin POST; API mode bypasses ChatGPT login', async () => {
  const f = fixture()
  const handler = createTextAccessApi(f.provider)
  for (const path of ['/status', '/login', '/cancel']) {
    const res = await request(handler, path, 'https://evil.test')
    assert.equal(res.status, 403)
  }
  assert.equal(f.calls.length, 0)
  const res = await request(handler, '/status')
  assert.deepEqual(JSON.parse(res.text), { provider: 'codex', authenticated: true, login: null })
  assert.equal(res.headers['Cache-Control'], 'no-store')
  const api = await request(createTextAccessApi(), '/status')
  assert.equal(JSON.parse(api.text).provider, 'api')
  f.provider.close()
})

test('Codex integrates with the existing NDJSON endpoint and pre-stream auth errors', async () => {
  const f = fixture()
  const handler = createChatApi(undefined, undefined, f.provider.chat)
  const res = await request(handler, '/', undefined, { messages })
  assert.deepEqual(res.text.trim().split('\n').map(JSON.parse), [{ type: 'delta', text: 'Hello' }, { type: 'done' }])
  f.setAuth(false)
  const denied = await request(handler, '/', undefined, { messages })
  assert.equal(denied.status, 401)
  assert.equal(JSON.parse(denied.text).error.code, 'access_denied')
  f.provider.close()
})

test('cancel during login startup cancels the returned login and never leaves it pending', async () => {
  let resolveLogin
  const f = fixture({ 'account/login/start': () => new Promise((resolve) => { resolveLogin = resolve }) })
  const starting = f.provider.startLogin()
  await f.provider.cancelLogin()
  resolveLogin({ type: 'chatgpt', loginId: 'late', authUrl: 'https://chatgpt.com/auth' })
  await assert.rejects(starting)
  assert.equal((await f.provider.status()).login.state, 'failed')
  assert.ok(f.calls.some((c) => c.method === 'account/login/cancel' && c.params.loginId === 'late'))
  f.provider.close()
})
