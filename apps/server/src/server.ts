import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import type { ServerConfig } from './config.ts'
import type { createRuntime } from './runtime.ts'

/** Start both listeners as one unit, and unwind them if either bind fails. */
export function createBackendServer(config: ServerConfig, runtime: ReturnType<typeof createRuntime>, fetch: Parameters<typeof getRequestListener>[0]) {
  const server = createServer(getRequestListener(fetch))
  server.headersTimeout = 10_000
  server.requestTimeout = 120_000
  server.maxConnections = 64
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      await runtime.close()
      await starting?.catch(() => {})
      if (server.listening) {
        const stopped = new Promise<void>(resolve => server.close(() => resolve()))
        server.closeAllConnections()
        await stopped
      }
    })()
    return closing
  }
  const listen = () => {
    if (closing) return Promise.reject(new Error('Backend listener is closed.'))
    starting ??= (async () => {
      await runtime.speech?.listen()
      await new Promise<void>((resolve, reject) => {
        const failed = (error: NodeJS.ErrnoException) => {
          server.off('listening', ready)
          reject(new Error(error.code === 'EADDRINUSE'
            ? 'HTTP API port is in use. Stop the other listener or change DOT_API_PORT.'
            : 'Could not bind HTTP API. Check DOT_API_HOST and DOT_API_PORT.'))
        }
        const ready = () => { server.off('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(config.port, config.host)
      })
    })()
    return starting.catch(async error => { await close(); throw error })
  }
  return { server, listen, close }
}
