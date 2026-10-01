import { apiPaths, type TextAccessAction } from '@dot/contracts'
import { apiUrl } from './api-url.ts'
import type { TextAccessStatus } from '@dot/contracts'
export type AccessSnapshot = { pending: boolean; message: string | null; checking: boolean; authenticated: boolean | null }
type LoginWindow = { closed: boolean; location: { href: string }; close(): void; opener: unknown }
type AccessStatus = TextAccessStatus
const failed = 'Could not open text chat. Check the local server and try again.'
const canceled = 'ChatGPT sign-in was canceled. Try signing in again.'

async function accessRequest(action: TextAccessAction, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl(apiPaths.textAccess[action]), { method: 'POST', signal, keepalive: action === 'cancel' })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error(failed)
  if (!response.ok) {
    const error = 'error' in body ? body.error : null
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') throw new Error(error.message)
    throw new Error(failed)
  }
  return body as Record<string, unknown>
}

/** Server-confirmed authentication, checked at startup and during sign-in. */
export function createTextAccess(dependencies: {
  request?: typeof accessRequest
  openWindow?: () => LoginWindow | null
  pollMs?: number
  timeoutMs?: number
} = {}) {
  const request = dependencies.request ?? accessRequest
  const openWindow = dependencies.openWindow ?? (() => window.open('about:blank', '_blank', 'popup,width=520,height=720'))
  let snapshot: AccessSnapshot = { pending: false, message: null, checking: false, authenticated: null }
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined
  let popup: LoginWindow | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let loginStarted = false
  const update = (next: Partial<AccessSnapshot>) => { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener() }
  const finish = () => { clearTimeout(timer); clearTimeout(timeout); popup?.close(); popup = null; controller = undefined }
  const cancel = (message: string | null = canceled) => {
    controller?.abort()
    if (loginStarted) void request('cancel').catch(() => {})
    loginStarted = false
    finish()
    update({ pending: false, checking: false, message })
  }
  const getStatus = async (signal: AbortSignal) => {
    const status = await request('status', signal)
    if (!['api', 'codex'].includes(String(status.provider)) || typeof status.authenticated !== 'boolean') throw new Error(failed)
    return status as unknown as AccessStatus
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    cancel,
    async check() {
      if (snapshot.pending) return
      const active = new AbortController()
      controller = active
      update({ pending: true, checking: true, message: null })
      timeout = setTimeout(() => cancel('Could not check sign-in. Try connecting again.'), dependencies.timeoutMs ?? 180_000)
      try {
        const status = await getStatus(active.signal)
        if (active.signal.aborted) return
        finish()
        update({ pending: false, checking: false, authenticated: status.authenticated, message: null })
      } catch (error) {
        if (active.signal.aborted) return
        cancel(error instanceof Error ? error.message : failed)
      }
    },
    async enter(onAllowed: () => void) {
      if (snapshot.pending) { cancel(); return }
      const active = new AbortController()
      controller = active
      update({ pending: true, checking: false, message: 'Checking sign-in…' })
      // Open during the user gesture; navigation after async checks is blocked by browsers.
      popup = openWindow()
      if (popup) popup.opener = null
      const assertActive = () => { if (active.signal.aborted) throw new Error(canceled) }
      timeout = setTimeout(() => cancel('ChatGPT sign-in timed out. Try signing in again.'), dependencies.timeoutMs ?? 180_000)
      try {
        let status = await getStatus(active.signal)
        assertActive()
        if (!status.authenticated) {
          if (!popup) throw new Error('Allow pop-up windows for this app, then try signing in with ChatGPT again.')
          loginStarted = true
          const login = await request('login', active.signal)
          assertActive()
          if (typeof login.authUrl !== 'string' || typeof login.loginId !== 'string') throw new Error(failed)
          const url = new URL(login.authUrl)
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error(failed)
          popup.location.href = url.href
          update({ pending: true, authenticated: false, message: 'Finish signing in with ChatGPT in the other window.' })
          while (true) {
            status = await getStatus(active.signal)
            assertActive()
            if (status.login?.id !== login.loginId) throw new Error('ChatGPT sign-in was interrupted. Try signing in again.')
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
        update({ pending: false, checking: false, authenticated: true, message: null })
        onAllowed()
      } catch (error) {
        if (active.signal.aborted) return
        cancel(error instanceof Error ? error.message : failed)
      }
    },
  }
}
