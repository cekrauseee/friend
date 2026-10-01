import type { ApiPath } from '@dot/contracts'

/** Join shared API paths to an optional, explicitly configured HTTP base. */
export function createApiUrl(base = ''): (path: ApiPath) => string {
  const value = base.trim()
  if (!value) return (path) => path

  let url: URL
  try { url = new URL(value) } catch { throw new Error('VITE_API_BASE_URL must be an absolute HTTP(S) URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.')
  }
  const normalized = url.href.replace(/\/+$/, '')
  return (path) => `${normalized}${path}`
}

export const apiUrl = createApiUrl(import.meta.env?.VITE_API_BASE_URL)
