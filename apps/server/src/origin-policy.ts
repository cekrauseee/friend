import type { IncomingMessage } from 'node:http'

const authorizedRequests = new WeakSet<IncomingMessage>()
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackOrigin(value: string) {
  try { return loopbackNames.has(new URL(value).hostname) } catch { return false }
}

/** Exact browser origins only: paths, credentials, opaque origins and wildcards are invalid. */
export function validFrontendOrigin(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value
      && !url.username && !url.password && !value.includes('*')
  } catch { return false }
}

/** Bridge a checked Hono request to the existing raw Node handlers. */
export async function withAuthorizedOrigin<T>(request: IncomingMessage, action: () => T | Promise<T>): Promise<T> {
  authorizedRequests.add(request)
  try { return await action() } finally { authorizedRequests.delete(request) }
}

/** Direct handler callers retain the original local-only policy. */
export function isAllowedOrigin(request: IncomingMessage) {
  if (authorizedRequests.has(request)) return true
  try {
    if (!request.headers.origin) return request.method === 'GET'
      && request.headers['sec-fetch-site'] === 'same-origin'
      && loopbackNames.has(new URL(`http://${request.headers.host}`).hostname)
    const origin = new URL(request.headers.origin)
    if (isLoopbackOrigin(origin.origin) && ['http:', 'https:'].includes(origin.protocol)
      && origin.host === request.headers.host) return true
    return false
  } catch { return false }
}
