import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { createSpeechEngineBridge, type SpeechEngineBridgeOptions } from './speech-engine.ts'

export function speechEngineAddress(host = '127.0.0.1', port = '3001') {
  if (!isIP(host)) throw new Error('DOT_SPEECH_ENGINE_HOST must be an IP address (default 127.0.0.1).')
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('DOT_SPEECH_ENGINE_PORT must be a port from 1 to 65535 (default 3001).')
  }
  return { host, port: Number(port) }
}

/** Separate upstream transport: never mounts frontend, login or local API routes. */
export function createSpeechEngineServer(options: SpeechEngineBridgeOptions & { host?: string; port?: number }) {
  const { host = '127.0.0.1', port = 3001 } = options
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'Cache-Control': 'no-store', Connection: 'close' })
    res.end()
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 10_000
  server.maxConnections = 64
  const bridge = createSpeechEngineBridge(options)
  bridge.attach(server)
  let starting: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      await starting?.catch(() => {})
      await bridge.close()
      if (server.listening) {
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await stopped
      }
    })()
    return closing
  }
  const listen = () => {
    if (closing) return Promise.reject(new Error('Speech Engine listener is closed.'))
    starting ??= new Promise<void>((resolve, reject) => {
      const failed = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', ready)
        reject(new Error(error.code === 'EADDRINUSE'
          ? 'Speech Engine upstream port is in use. Stop the other listener or change DOT_SPEECH_ENGINE_PORT.'
          : 'Could not bind Speech Engine upstream. Check DOT_SPEECH_ENGINE_HOST and DOT_SPEECH_ENGINE_PORT.'))
      }
      const ready = () => { server.removeListener('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen(port, host)
    })
    return starting.catch(async (error) => { await close(); throw error })
  }
  return { server, listen, close }
}
