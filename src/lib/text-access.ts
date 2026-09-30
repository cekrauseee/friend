export type AccessSnapshot = { pending: boolean; message: string | null }
type LoginWindow = { closed: boolean; location: { href: string }; close(): void; opener: unknown }
type AccessStatus = { provider: 'codex' | 'api'; authenticated: boolean; login: { id: string; state: string; message?: string } | null }
const failed = 'Could not open text chat. Check the local server and try again.'
const canceled = 'ChatGPT sign-in was canceled. Select text chat to try again.'

async function accessRequest(action: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/text-access/${action}`, { method: 'POST', signal, keepalive: action === 'cancel' })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error(failed)
  if (!response.ok) {
    const error = 'error' in body ? body.error : null
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') throw new Error(error.message)
    throw new Error(failed)
  }
  return body as Record<string, unknown>
}

/** Entry gate: no text-mode transition until server-confirmed access. */
export function createTextAccess(dependencies: {
  request?: typeof accessRequest
  openWindow?: () => LoginWindow | null
  pollMs?: number
  timeoutMs?: number
} = {}) {
  const request = dependencies.request ?? accessRequest
  const openWindow = dependencies.openWindow ?? (() => window.open('about:blank', '_blank', 'popup,width=520,height=720'))
  let snapshot: AccessSnapshot = { pending: false, message: null }
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined
  let popup: LoginWindow | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let loginStarted = false
  const update = (next: AccessSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const finish = () => { clearTimeout(timer); clearTimeout(timeout); popup?.close(); popup = null; controller = undefined }
  const cancel = (message: string | null = canceled) => {
    controller?.abort()
    if (loginStarted) void request('cancel').catch(() => {})
    loginStarted = false
    finish()
    update({ pending: false, message })
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    cancel,
    async enter(onAllowed: () => void) {
      if (snapshot.pending) { cancel(); return }
      const active = new AbortController()
      controller = active
      update({ pending: true, message: 'Checking text chat access…' })
      // Open during the user gesture; navigation after async checks is blocked by browsers.
      popup = openWindow()
      if (popup) popup.opener = null
      const assertActive = () => { if (active.signal.aborted) throw new Error(canceled) }
      const getStatus = async () => {
        const status = await request('status', active.signal)
        if (!['api', 'codex'].includes(String(status.provider)) || typeof status.authenticated !== 'boolean') throw new Error(failed)
        return status as unknown as AccessStatus
      }
      timeout = setTimeout(() => cancel('ChatGPT sign-in timed out. Select text chat to try again.'), dependencies.timeoutMs ?? 180_000)
      try {
        let status = await getStatus()
        assertActive()
        if (!status.authenticated) {
          if (!popup) throw new Error('Allow pop-up windows for this app, then select text chat to sign in with ChatGPT.')
          loginStarted = true
          const login = await request('login', active.signal)
          assertActive()
          if (typeof login.authUrl !== 'string' || typeof login.loginId !== 'string') throw new Error(failed)
          const url = new URL(login.authUrl)
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error(failed)
          popup.location.href = url.href
          update({ pending: true, message: 'Finish signing in with ChatGPT in the other window. Select text chat again to cancel.' })
          while (true) {
            status = await getStatus()
            assertActive()
            if (status.login?.id !== login.loginId) throw new Error('ChatGPT sign-in was interrupted. Select text chat to try again.')
            if (status.login.state === 'failed') throw new Error(status.login.message ?? canceled)
            if (status.authenticated && status.login.state === 'succeeded') break
            // Auth pages may sever the window handle through COOP. Completion
            // comes from the server; the main-screen button always cancels.
            await new Promise<void>((resolve) => {
              const done = () => { clearTimeout(timer); active.signal.removeEventListener('abort', done); resolve() }
              timer = setTimeout(done, dependencies.pollMs ?? 750)
              active.signal.addEventListener('abort', done, { once: true })
            })
            assertActive()
          }
        }
        loginStarted = false
        finish()
        update({ pending: false, message: null })
        onAllowed()
      } catch (error) {
        if (active.signal.aborted) return
        cancel(error instanceof Error ? error.message : failed)
      }
    },
  }
}
