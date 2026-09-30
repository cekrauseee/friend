import type { IncomingMessage, ServerResponse } from 'node:http'
import { ChatError, isLocalOrigin, replyError, type ChatEvent, type ChatMessage } from './chat-api.ts'
import { createCodexProcess, type CodexRpc, type RpcMessage } from './codex-process.ts'

const unavailable = () => new ChatError(503, 'not_configured', 'Could not connect to Codex. Install Codex CLI 0.156.1, then try again.')
const accessError = () => new ChatError(401, 'access_denied', 'Sign in with ChatGPT from the main screen to use text chat.')
const replyFailure = () => new ChatError(502, 'upstream_error', 'Codex could not complete the reply. Check your ChatGPT model access and usage limits, then try again.')
const loginError = 'ChatGPT sign-in did not complete. Select text chat to try again.'
type Login = { id: string; state: 'pending' | 'succeeded' | 'failed'; message?: string }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} }

export function validAuthUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(url.hostname)
  } catch { return false }
}

export function createCodexProvider(rpc: CodexRpc = createCodexProcess(), options: { loginTimeoutMs?: number; turnTimeoutMs?: number } = {}) {
  let login: Login | undefined
  let loginTimer: ReturnType<typeof setTimeout> | undefined
  let startingLogin = false
  let cancelStartingLogin = false
  const finishLogin = (state: 'succeeded' | 'failed') => {
    if (!login || login.state !== 'pending') return
    clearTimeout(loginTimer)
    login = { id: login.id, state, ...(state === 'failed' ? { message: loginError } : {}) }
  }
  const account = async () => {
    try {
      const result = object(await rpc.request('account/read', { refreshToken: true }))
      return object(result.account).type === 'chatgpt'
    } catch { throw unavailable() }
  }
  const unsubscribe = rpc.subscribe((message) => {
    const params = object(message.params)
    if (message.method === 'friend/process/error') finishLogin('failed')
    if (message.method === 'account/login/completed' && params.loginId === login?.id) {
      if (params.success === true) void account().then((valid) => finishLogin(valid ? 'succeeded' : 'failed'), () => finishLogin('failed'))
      else finishLogin('failed')
    }
    if (message.method === 'account/updated' && params.authMode === 'chatgpt' && login?.state === 'pending') {
      void account().then((valid) => { if (valid) finishLogin('succeeded') }, () => finishLogin('failed'))
    }
  })

  const cancelLogin = async () => {
    cancelStartingLogin = startingLogin
    const current = login
    finishLogin('failed')
    if (current?.state === 'pending') await rpc.request('account/login/cancel', { loginId: current.id }).catch(() => {})
  }
  const status = async () => ({ provider: 'codex', authenticated: await account(), login: login ?? null })
  const startLogin = async () => {
    if (startingLogin || login?.state === 'pending') throw new ChatError(409, 'invalid_request', 'ChatGPT sign-in is already open. Finish or cancel it before trying again.')
    startingLogin = true
    cancelStartingLogin = false
    try {
      const result = object(await rpc.request('account/login/start', { type: 'chatgpt' }))
      if (result.type !== 'chatgpt' || typeof result.loginId !== 'string' || !validAuthUrl(result.authUrl)) {
        if (typeof result.loginId === 'string') await rpc.request('account/login/cancel', { loginId: result.loginId }).catch(() => {})
        throw unavailable()
      }
      login = { id: result.loginId, state: 'pending' }
      if (cancelStartingLogin) { await cancelLogin(); throw accessError() }
      loginTimer = setTimeout(() => { void cancelLogin() }, options.loginTimeoutMs ?? 180_000)
      return { loginId: login.id, authUrl: result.authUrl }
    } catch (error) { if (error instanceof ChatError) throw error; throw unavailable() }
    finally { startingLogin = false }
  }

  async function* chat(messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<ChatEvent> {
    if (!await account()) throw accessError()
    if (signal.aborted) return
    let threadId: string | undefined
    let turnId: string | undefined
    const queue: RpcMessage[] = []
    let wake: (() => void) | undefined
    let emittedText = false
    let completed = false
    let timedOut = false
    const push = (message: RpcMessage) => { queue.push(message); wake?.(); wake = undefined }
    const stop = rpc.subscribe((message) => {
      if (message.method === 'friend/process/error' || message.method === 'friend/request/rejected' || (threadId && message.params?.threadId === threadId)) push(message)
    })
    const abort = () => push({ method: 'friend/abort' })
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; abort() }, options.turnTimeoutMs ?? 120_000)
    try {
      const started = object(await rpc.request('thread/start', {
        model: 'gpt-6-luna', modelProvider: 'openai', allowProviderModelFallback: false,
        ephemeral: true, environments: [], dynamicTools: [], runtimeWorkspaceRoots: [],
        approvalPolicy: 'never', sandbox: 'read-only',
        config: { model_reasoning_effort: 'none', 'agents.enabled': false },
        baseInstructions: 'You are Friend, a text conversation assistant. The user supplies a JSON conversation with user and assistant messages. Continue it by answering the final user message. Return only your reply as plain text or Markdown. Do not use tools.',
      }))
      threadId = object(started.thread).id as string
      if (typeof threadId !== 'string' || started.model !== 'gpt-6-luna' || started.reasoningEffort !== 'none') throw replyFailure()
      if (timedOut) throw replyFailure()
      if (signal.aborted) return
      const result = object(await rpc.request('turn/start', {
        threadId, model: 'gpt-6-luna', effort: 'none', environments: [],
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        input: [{ type: 'text', text: JSON.stringify(messages) }],
      }))
      turnId = object(result.turn).id as string
      if (typeof turnId !== 'string') throw replyFailure()
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
        const message = queue.shift()
        if (!message) continue
        if (message.method === 'friend/abort') { if (timedOut) throw replyFailure(); return }
        if (message.method === 'friend/process/error' || message.method === 'friend/request/rejected') throw replyFailure()
        const params = object(message.params)
        if (params.turnId && params.turnId !== turnId) continue
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta) {
          emittedText = true
          yield { type: 'delta', text: params.delta }
        } else if (message.method === 'turn/completed') {
          const turn = object(params.turn)
          if (turn.id !== turnId) continue
          completed = true
          if (turn.status !== 'completed' || !emittedText) throw replyFailure()
          yield { type: 'done' }
          return
        } else if (message.method === 'error' && params.willRetry !== true) throw replyFailure()
      }
    } catch (error) {
      if (signal.aborted) return
      throw error instanceof ChatError ? error : replyFailure()
    } finally {
      clearTimeout(timer)
      stop()
      signal.removeEventListener('abort', abort)
      if (threadId && turnId && !completed) await rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      if (threadId) await rpc.request('thread/unsubscribe', { threadId }).catch(() => {})
    }
  }

  return { chat, status, startLogin, cancelLogin, close() { clearTimeout(loginTimer); unsubscribe(); rpc.close() } }
}

export function createTextAccessApi(codex?: ReturnType<typeof createCodexProvider>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') return replyError(response, new ChatError(405, 'method_not_allowed', 'Use POST to check text chat access.'))
    if (!isLocalOrigin(request)) return replyError(response, new ChatError(403, 'forbidden_origin', 'Requests must come from this local app.'))
    try {
      let body: unknown
      if (request.url === '/status') body = codex ? await codex.status() : { provider: 'api', authenticated: true, login: null }
      else if (request.url === '/login' && codex) body = await codex.startLogin()
      else if (request.url === '/cancel' && codex) { await codex.cancelLogin(); body = { canceled: true } }
      else throw new ChatError(404, 'invalid_request', 'Text chat access action not found.')
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    } catch (error) { replyError(response, error instanceof ChatError ? error : unavailable()) }
  }
}
