import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { ChatMessage, ChatProvider } from './chat-api.ts'
import { verifySpeechEngineAuthorization } from './speech-engine-auth.ts'

const MAX_FRAME_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_MESSAGES = 200
const MAX_CONTENT_BYTES = 32 * 1024

export type SpeechEngineBridgeOptions = {
  apiKey: string
  provider: ChatProvider
  admission: { consume(conversationId: string): boolean }
  path?: string
  maxSessions?: number
  initTimeoutMs?: number
  idleTimeoutMs?: number
  turnTimeoutMs?: number
}

/** Adapter for https://elevenlabs.io/docs/api-reference/speech-engine/speech-engine-upstream.
 * Uses ws rather than SDK interruption callbacks to retain sequential-only turn handling.
 * Isolated authenticated upstream. Sequential turns only: duplicates, older IDs and
 * concurrent turns close the session; no queued inference or speech interruption.
 * close() detaches upgrades and terminates sessions, but does not close the HTTP server.
 * Wire only to the public upstream listener, never the local app/API listener.
 */
export function createSpeechEngineBridge({
  apiKey, provider, admission, path = '/speech-engine/upstream', maxSessions = 32,
  initTimeoutMs = 10_000, idleTimeoutMs = 120_000, turnTimeoutMs = 120_000,
}: SpeechEngineBridgeOptions) {
  if (!apiKey || !path.startsWith('/') || !Number.isSafeInteger(maxSessions) || maxSessions < 1
    || [initTimeoutMs, idleTimeoutMs, turnTimeoutMs].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Invalid Speech Engine bridge configuration.')
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
  let attached: Server | undefined
  let closed = false
  const cleanup = new Map<WebSocket, () => void>()

  const connect = (socket: WebSocket) => {
    let initialized = false
    let stopped = false
    let active: AbortController | undefined
    let lastEvent = -1
    let chunks = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const timer = (action: () => void, duration: number) => {
      const handle = setTimeout(() => { timers.delete(handle); action() }, duration)
      handle.unref()
      timers.add(handle)
      return handle
    }
    const cancelTimer = (handle: ReturnType<typeof setTimeout>) => {
      clearTimeout(handle)
      timers.delete(handle)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      active?.abort()
      for (const handle of timers) clearTimeout(handle)
      timers.clear()
    }
    cleanup.set(socket, stop)
    const end = (code: number, reason: string) => {
      if (stopped) return
      stop()
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
      // Bound a peer that never acknowledges the close handshake.
      if (socket.readyState !== WebSocket.CLOSED) timer(() => socket.terminate(), 1000)
    }
    const fail = () => end(1011, 'Could not complete the reply.')
    const initTimer = timer(() => end(1008, 'Session initialization required.'), initTimeoutMs)
    let idleTimer = timer(() => end(1008, 'Session timed out.'), idleTimeoutMs)
    const send = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
      if (stopped || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_OUTPUT_BYTES) {
        reject(new Error('Speech Engine transport unavailable.'))
        return
      }
      socket.send(JSON.stringify(value), (error) => error ? reject(error) : resolve())
    })
    const respond = async (eventId: number, messages: ChatMessage[]) => {
      const controller = new AbortController()
      active = controller
      chunks = 0
      const turnTimer = timer(fail, turnTimeoutMs)
      let outputBytes = 0
      let complete = false
      try {
        for await (const event of provider(messages, controller.signal)) {
          if (stopped || controller.signal.aborted) return
          if (event.type === 'error') throw new Error('Provider failed.')
          if (event.type === 'done') {
            if (!outputBytes) throw new Error('Empty provider result.')
            await send({ type: 'agent_response', event_id: eventId, content: '', is_final: true })
            complete = true
            break
          }
          if (event.type !== 'delta' || typeof event.text !== 'string') throw new Error('Invalid provider event.')
          if (!event.text) continue
          outputBytes += Buffer.byteLength(event.text)
          if (outputBytes > MAX_OUTPUT_BYTES || ++chunks > 8192) throw new Error('Provider output too large.')
          await send({ type: 'agent_response', event_id: eventId, content: event.text, is_final: false })
        }
        if (!complete && !stopped) fail()
      } catch { if (!stopped) fail() }
      finally {
        controller.abort()
        cancelTimer(turnTimer)
        if (active === controller) active = undefined
      }
    }
    socket.on('message', (data, binary) => {
      if (stopped) return
      cancelTimer(idleTimer)
      idleTimer = timer(() => end(1008, 'Session timed out.'), idleTimeoutMs)
      try {
        if (binary) throw new Error('Binary frame.')
        const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid frame.')
        if (message.type === 'close') return end(1000, 'Session ended.')
        if (message.type === 'error') return fail()
        if (message.type === 'ping') { void send({ type: 'pong' }).catch(fail); return }
        if (message.type === 'init') {
          if (initialized || typeof message.conversation_id !== 'string'
            || !admission.consume(message.conversation_id)) throw new Error('Invalid session.')
          initialized = true
          cancelTimer(initTimer)
          return
        }
        if (!initialized || message.type !== 'user_transcript' || active
          || !Number.isSafeInteger(message.event_id) || message.event_id < 0 || message.event_id <= lastEvent
          || !Array.isArray(message.user_transcript) || !message.user_transcript.length
          || message.user_transcript.length > MAX_MESSAGES) throw new Error('Invalid turn.')
        const messages: ChatMessage[] = message.user_transcript.map((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || !('role' in entry) || !('content' in entry)
            || (entry.role !== 'user' && entry.role !== 'agent') || typeof entry.content !== 'string'
            || !entry.content.trim() || Buffer.byteLength(entry.content) > MAX_CONTENT_BYTES) {
            throw new Error('Invalid transcript.')
          }
          return { role: entry.role === 'agent' ? 'assistant' : 'user', content: entry.content }
        })
        if (messages.at(-1)?.role !== 'user') throw new Error('Missing user turn.')
        lastEvent = message.event_id
        void respond(message.event_id, messages)
      } catch { end(1008, 'Invalid Speech Engine message.') }
    })
    socket.on('error', stop)
    socket.once('close', () => { stop(); for (const handle of timers) clearTimeout(handle); cleanup.delete(socket) })
  }
  wss.on('connection', connect)
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (closed) return reject(503)
    if (request.url !== path) return reject(404)
    if (!verifySpeechEngineAuthorization(request.headers['x-elevenlabs-speech-engine-authorization'], apiKey)) {
      return reject(401)
    }
    if (wss.clients.size >= maxSessions) return reject(503)
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
  }
  return {
    attach(server: Server) {
      if (attached || closed) throw new Error('Speech Engine bridge already attached or closed.')
      attached = server
      server.on('upgrade', upgrade)
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      attached?.off('upgrade', upgrade)
      for (const [socket, stop] of cleanup) { stop(); socket.terminate() }
      return new Promise((resolve) => wss.close(() => resolve()))
    },
  }
}
