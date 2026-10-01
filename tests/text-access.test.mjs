import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextAccess } from '../src/lib/text-access.ts'
const tick = () => new Promise((r) => setImmediate(r))
function fixture(statuses, overrides = {}) {
  const calls = []
  let entries = 0
  const popup = { closed: false, opener: {}, location: { href: '' }, close() { this.closed = true } }
  const gate = createTextAccess({ pollMs: 1, timeoutMs: 1000, openWindow: () => popup,
    request: async (action) => {
      calls.push(action)
      if (action === 'status') return statuses.length > 1 ? statuses.shift() : statuses[0]
      if (action === 'login') return { authUrl: 'https://auth.openai.com/authorize', loginId: 'one' }
      return {}
    }, ...overrides })
  return { gate, popup, calls, enter: () => gate.enter(() => { entries++ }), entries: () => entries }
}
const signedOut = { provider: 'codex', authenticated: false, login: null }
const pending = { provider: 'codex', authenticated: false, login: { id: 'one', state: 'pending' } }
const success = { provider: 'codex', authenticated: true, login: { id: 'one', state: 'succeeded' } }

test('authenticated and API access enter text only after server confirmation', async () => {
  for (const provider of ['codex', 'api']) {
    const f = fixture([{ provider, authenticated: true, login: null }])
    const promise = f.enter()
    assert.equal(f.entries(), 0)
    await promise
    assert.equal(f.entries(), 1); assert.equal(f.popup.closed, true)
    assert.deepEqual(f.calls, ['status'])
  }
})
test('signed-out click opens authentication, then enters text on confirmed success', async () => {
  const f = fixture([signedOut, pending, success])
  await f.enter()
  assert.equal(f.popup.location.href, 'https://auth.openai.com/authorize')
  assert.equal(f.popup.opener, null)
  assert.equal(f.entries(), 1)
  assert.deepEqual(f.gate.getSnapshot(), { pending: false, message: null, checking: false, authenticated: true })
})
test('refusal stays on main screen with error and supports retry', async () => {
  const statuses = [signedOut, { ...pending, login: { id: 'one', state: 'failed', message: 'Sign-in declined. Try again.' } }]
  const f = fixture(statuses)
  await f.enter()
  assert.equal(f.entries(), 0)
  assert.match(f.gate.getSnapshot().message, /declined/)
  statuses.splice(0, statuses.length, success)
  await f.enter()
  assert.equal(f.entries(), 1)
})
test('blocked popup, closure, process restart, network error and timeout preserve main screen', async () => {
  const cases = [
    fixture([signedOut], { openWindow: () => null }),
    fixture([signedOut, pending], { timeoutMs: 5, openWindow: () => ({ closed: true, opener: null, location: {}, close() {} }) }),
    fixture([signedOut, signedOut]),
    fixture([], { request: async () => { throw new Error('Local server unavailable') } }),
    fixture([signedOut, pending], { timeoutMs: 5 }),
  ]
  for (const f of cases) {
    await f.enter()
    assert.equal(f.entries(), 0)
    assert.equal(f.gate.getSnapshot().pending, false)
    assert.ok(f.gate.getSnapshot().message)
  }
})
test('second click and disposal cancel polling and ignore late authentication', async () => {
  const f = fixture([signedOut, pending])
  const entering = f.enter(); await tick()
  await f.enter(); await entering
  assert.equal(f.entries(), 0)
  assert.ok(f.calls.includes('cancel'))
  assert.match(f.gate.getSnapshot().message, /canceled/)
  let resolveStatus
  const late = fixture([], { request: () => new Promise((resolve) => { resolveStatus = resolve }) })
  const run = late.enter()
  late.gate.cancel(null)
  resolveStatus(success); await run
  assert.equal(late.entries(), 0)
  assert.deepEqual(late.gate.getSnapshot(), { pending: false, message: null, checking: false, authenticated: null })
})


test('startup checks existing authentication without opening a popup or starting login', async () => {
  for (const status of [signedOut, success, { provider: 'api', authenticated: true, login: null }]) {
    let opened = false
    const f = fixture([status], { openWindow: () => { opened = true; return null } })
    const run = f.gate.check()
    assert.equal(f.gate.getSnapshot().checking, true)
    await run
    assert.equal(opened, false)
    assert.deepEqual(f.calls, ['status'])
    assert.equal(f.gate.getSnapshot().authenticated, status.authenticated)
    assert.equal(f.gate.getSnapshot().checking, false)
  }
})

test('startup failure can retry, and disposed checks cannot authenticate late', async () => {
  let reject = true
  const f = fixture([], { request: async () => {
    if (reject) throw new Error('Server offline')
    return success
  } })
  await f.gate.check()
  assert.equal(f.gate.getSnapshot().message, 'Server offline')
  reject = false
  await f.gate.check()
  assert.equal(f.gate.getSnapshot().authenticated, true)
  let resolve
  const late = fixture([], { request: () => new Promise((done) => { resolve = done }) })
  const run = late.gate.check()
  late.gate.cancel(null)
  resolve(success)
  await run
  assert.equal(late.gate.getSnapshot().authenticated, null)
  assert.equal(late.gate.getSnapshot().checking, false)
})
