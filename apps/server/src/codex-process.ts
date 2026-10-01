import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
export interface CodexRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (message: RpcMessage) => void): () => void
  close(): void
}

// Keep this in step with the CLI protocol smoke test. Empty environments remove
// executable capabilities; read-only and never are additional restrictions.
export const codexConfig = {
  model: 'gpt-6-luna', model_reasoning_effort: 'none', model_provider: 'openai',
  approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
  'agents.enabled': false, 'apps._default.enabled': false,
  cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt',
  check_for_update_on_startup: false,
}
export const disabledFeatures = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'multi_agent',
  'goals', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'view_image',
  'sleep_tool', 'workspace_dependencies', 'skill_search', 'code_mode_host',
  'memories', 'shell_snapshot', 'tool_suggest',
]
export const codexArgs = ['app-server', '--listen', 'stdio://',
  ...Object.entries(codexConfig).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
  ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
]

/** Reuse an existing local sign-in; new profiles use the current product name. */
export async function resolveCodexAuthHome(base = join(homedir(), '.local', 'share')) {
  const current = join(base, 'dot', 'codex')
  const previous = join(base, 'friend', 'codex')
  for (const directory of [current, previous]) {
    try { await access(directory); return directory }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return current
}

/** Lazy, isolated stdio process. Never inherits API keys or the caller's CODEX_HOME. */
export function createCodexProcess(options: { launch?: typeof spawn; authHome?: string; requestTimeoutMs?: number } = {}): CodexRpc {
  let child: ChildProcessWithoutNullStreams | undefined
  let ready: Promise<void> | undefined
  let directory: string | undefined
  let sequence = 0
  let closed = false
  const listeners = new Set<(message: RpcMessage) => void>()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const emit = (message: RpcMessage) => { for (const listener of listeners) listener(message) }
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex unavailable')) }
    pending.clear()
    emit({ method: 'dot/process/error' })
  }
  const write = (message: RpcMessage) => {
    if (!child || child.killed || !child.stdin.writable) throw new Error('Codex unavailable')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex timed out')); child?.kill(); fail() }, options.requestTimeoutMs ?? 20_000)
    pending.set(id, { resolve, reject, timer })
    try { write({ id, method, params }) } catch { clearTimeout(timer); pending.delete(id); reject(new Error('Codex unavailable')) }
  })
  const start = async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'dot-codex-'))
    directory = runtimeDirectory
    const authHome = options.authHome ?? await resolveCodexAuthHome()
    await mkdir(authHome, { recursive: true, mode: 0o700 })
    if (closed) { await rm(runtimeDirectory, { recursive: true, force: true }); throw new Error('Codex closed') }
    child = (options.launch ?? spawn)('codex', codexArgs, {
      cwd: directory,
      env: { PATH: process.env.PATH, CODEX_HOME: authHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const running = child
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (child === running) { fail(); child = undefined; ready = undefined }
      running.kill()
      void rm(runtimeDirectory, { recursive: true, force: true })
    }
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) { child?.kill(); fail(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: RpcMessage
        try { message = JSON.parse(line) as RpcMessage } catch { child?.kill(); fail(); return }
        if (!message || typeof message !== 'object') { child?.kill(); fail(); return }
        if (message.method && message.id !== undefined) {
          // No browser approval, tool execution, input or token refresh is delegated.
          try { write({ id: message.id, error: { code: -32601, message: 'Client requests are disabled.' } }) } catch { fail() }
          emit({ method: 'dot/request/rejected', params: message.params })
        } else if (typeof message.id === 'number') {
          const entry = pending.get(message.id)
          if (!entry) continue
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.error) entry.reject(new Error('Codex request failed'))
          else entry.resolve(message.result)
        } else if (message.method) emit(message)
      }
    })
    // Drain diagnostics without logging tokens, login URLs or upstream details.
    child.stderr.resume()
    child.stdin.on('error', dispose)
    child.on('error', dispose)
    child.on('exit', dispose)
    const initialized = await request('initialize', { clientInfo: { name: 'dot', title: 'Dot', version: '0.0.0' }, capabilities: { experimentalApi: true } }).catch((error: unknown) => { dispose(); throw error })
    if (!initialized || typeof initialized !== 'object' || !('userAgent' in initialized)
      || typeof initialized.userAgent !== 'string' || !initialized.userAgent.startsWith('dot/0.156.1 ')) {
      dispose(); throw new Error('Unsupported Codex CLI version')
    }
    write({ method: 'initialized' })
  }
  return {
    async request(method, params) {
      if (closed) throw new Error('Codex closed')
      ready ??= start().catch((error: unknown) => { ready = undefined; throw error })
      await ready
      return request(method, params)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close() { closed = true; child?.kill(); fail(); if (directory) void rm(directory, { recursive: true, force: true }) },
  }
}
