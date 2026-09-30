import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createCodexProcess, resolveCodexAuthHome } from '../server/codex-process.ts'
import { createCodexProvider } from '../server/codex-provider.ts'
const tick = () => new Promise((r) => setImmediate(r))

test('new sign-in profiles use Dot while existing profiles remain available after renaming', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dot-auth-home-test-'))
  try {
    const current = join(base, 'dot', 'codex')
    const previous = join(base, 'friend', 'codex')
    assert.equal(await resolveCodexAuthHome(base), current)
    await mkdir(previous, { recursive: true })
    assert.equal(await resolveCodexAuthHome(base), previous)
    await mkdir(current, { recursive: true })
    assert.equal(await resolveCodexAuthHome(base), current)
  } finally { await rm(base, { recursive: true, force: true }) }
})

function fakeChild(onMessage) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false
  child.stdin = new Writable({ write(chunk, _encoding, done) { onMessage(JSON.parse(chunk), child); done() } })
  child.send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit')); return true }
  return child
}

test('stdio initialization, split frames, request correlation, denied server requests and isolated environment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dot-rpc-test-'))
  const sent = []; const notifications = []; let launched
  const child = fakeChild((message, process) => {
    sent.push(message)
    if (message.method === 'initialize') process.send({ id: message.id, result: { userAgent: 'dot/0.156.1 (test)' } })
  })
  const rpc = createCodexProcess({ authHome: home, launch: (...args) => { launched = args; return child } })
  rpc.subscribe((message) => notifications.push(message))
  try {
    const one = rpc.request('account/read', {})
    while (!sent.some((m) => m.method === 'account/read')) await tick()
    const two = rpc.request('model/list', {})
    await tick()
    assert.equal(sent[0].method, 'initialize'); assert.equal(sent[1].method, 'initialized')
    const read = sent.find((m) => m.method === 'account/read'); const models = sent.find((m) => m.method === 'model/list')
    const response = JSON.stringify({ id: read.id, result: { account: null } })
    child.send({ id: models.id, result: { data: [] } })
    child.stdout.write(response.slice(0, 10)); child.stdout.write(`${response.slice(10)}\n`)
    assert.deepEqual(await one, { account: null }); assert.deepEqual(await two, { data: [] })
    child.send({ id: 'server-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread' } })
    assert.equal(sent.at(-1).error.code, -32601)
    assert.ok(notifications.some((n) => n.method === 'dot/request/rejected'))
    assert.deepEqual(Object.keys(launched[2].env).sort(), ['CODEX_HOME', 'PATH'])
    assert.equal(launched[2].env.CODEX_HOME, home)
    assert.ok(launched[2].cwd.startsWith(tmpdir()))
    const pending = rpc.request('account/read', {})
    await tick(); child.kill()
    await assert.rejects(pending, /unavailable/)
  } finally { rpc.close(); await rm(home, { recursive: true, force: true }) }
})

test('unknown CLI versions and missing responses fail closed', async () => {
  for (const version of ['0.999.0', null]) {
    const home = await mkdtemp(join(tmpdir(), 'dot-rpc-test-'))
    const child = fakeChild((m, process) => { if (version && m.method === 'initialize') process.send({ id: m.id, result: { userAgent: `dot/${version} (test)` } }) })
    const rpc = createCodexProcess({ authHome: home, launch: () => child, requestTimeoutMs: 5 })
    try { await assert.rejects(rpc.request('account/read', {})); assert.equal(child.killed, true) }
    finally { rpc.close(); await rm(home, { recursive: true, force: true }) }
  }
})

const installed = spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim() === 'codex-cli 0.156.1'
test('installed CLI emits fixed inference settings without executable environment tools (local mock only)', { skip: !installed, timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dot-cli-test-'))
  let captured
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    captured = JSON.parse(body)
    const item = { type: 'message', id: 'msg-test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }
    const response = { id: 'resp-test', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Hello' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const rpc = createCodexProcess({ authHome: home, launch: (cmd, args, options) => spawn(cmd, [...args,
    '-c', 'model_provider="mock"', '-c', 'forced_login_method="chatgpt"',
    '-c', 'model_providers.mock.name="Mock"',
    '-c', `model_providers.mock.base_url="http://127.0.0.1:${server.address().port}"`,
    '-c', 'model_providers.mock.wire_api="responses"',
    '-c', 'model_providers.mock.requires_openai_auth=false',
    '-c', 'model_providers.mock.supports_websockets=false',
  ], options) })
  // The account fixture grants test access without ever creating a token or logging in.
  const provider = createCodexProvider({ ...rpc, request: (method, params) => method === 'account/read'
    ? Promise.resolve({ account: { type: 'chatgpt' } })
    : rpc.request(method, method === 'thread/start' ? { ...params, modelProvider: 'mock' } : params) })
  try {
    const events = await Array.fromAsync(provider.chat([{ role: 'user', content: 'Hello' }], new AbortController().signal))
    assert.deepEqual(events, [{ type: 'delta', text: 'Hello' }, { type: 'done' }])
    assert.equal(captured.model, 'gpt-6-luna'); assert.equal(captured.reasoning.effort, 'none')
    const tools = [...(captured.tools ?? []), ...captured.input.filter((i) => i.type === 'additional_tools').flatMap((i) => i.tools)]
    const names = tools.flatMap((tool) => tool.tools ? tool.tools.map((t) => t.name) : [tool.name])
    assert.deepEqual(names.sort(), ['exec', 'request_user_input', 'request_user_input_async', 'wait'])
    const nested = tools.flatMap((t) => t.tools ?? []).find((t) => t.name === 'exec').description
    assert.doesNotMatch(nested, /### `(exec_command|apply_patch|mcp__|view_image|spawn_agent)/)
    assert.match(nested, /no file system, no network access/)
  } finally {
    provider.close(); server.closeAllConnections()
    await new Promise((r) => server.close(r))
    await rm(home, { recursive: true, force: true })
  }
})
