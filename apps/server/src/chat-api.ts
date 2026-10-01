import type { IncomingMessage, ServerResponse } from 'node:http'
import type OpenAI from 'openai'

const MAX_BODY_BYTES = 256 * 1024
const MAX_MESSAGES = 200
const MAX_CONTENT_BYTES = 32 * 1024

export { ChatError, type ChatMessage, type ChatEvent, type ChatProvider } from './conversation-provider.ts'
import { ChatError, conversationErrors as errors, createApiChatProvider, upstreamError, type ChatMessage, type ChatEvent, type ChatProvider } from './conversation-provider.ts'

import { isAllowedOrigin } from './origin-policy.ts'
export { isAllowedOrigin as isLocalOrigin } from './origin-policy.ts'

export function replyError(response: ServerResponse, error: ChatError) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(error.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(error.status === 405 ? { Allow: 'POST' } : {}),
  })
  response.end(JSON.stringify({ error: { code: error.code, message: error.message } }))
}

async function readMessages(request: IncomingMessage): Promise<ChatMessage[]> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
    throw errors.media()
  }
  const length = request.headers['content-length']
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) throw errors.invalid()
    if (Number(length) > MAX_BODY_BYTES) throw errors.large()
  }

  const chunks: Buffer[] = []
  let size = 0
  // Keep the socket available so an oversized upload can still receive HTTP 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw errors.large()
    chunks.push(buffer)
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw errors.invalid()
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !('messages' in body)
    || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw errors.invalid()
  }
  if (body.messages.length > MAX_MESSAGES) throw errors.large()

  const messages: ChatMessage[] = []
  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).length !== 2 || !('role' in message) || !('content' in message)
      || message.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof message.content !== 'string' || message.content.trim().length === 0) {
      throw errors.invalid()
    }
    if (Buffer.byteLength(message.content, 'utf8') > MAX_CONTENT_BYTES) throw errors.large()
    messages.push({ role: message.role, content: message.content })
  }
  if (messages.at(-1)?.role !== 'user') throw errors.invalid()
  return messages
}

function writeEvent(response: ServerResponse, signal: AbortSignal, event: ChatEvent): Promise<void> {
  if (signal.aborted || response.destroyed) return Promise.resolve()
  if (response.write(`${JSON.stringify(event)}\n`)) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      response.off('drain', finish)
      response.off('close', finish)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    response.once('drain', finish)
    response.once('close', finish)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Local, stateless text endpoint. The browser sends only accepted turns. */
export function createChatApi(apiKey: string | undefined, client?: OpenAI, provider?: ChatProvider) {
  const chat = provider ?? createApiChatProvider(apiKey, client)

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') return replyError(response, errors.method())
    if (!isAllowedOrigin(request)) return replyError(response, errors.origin())
    if (!apiKey && !client && !provider) return replyError(response, errors.key())

    const controller = new AbortController()
    const onClose = () => { if (!response.writableEnded) controller.abort() }
    const onRequestAborted = () => controller.abort()
    response.on('close', onClose)
    request.on('aborted', onRequestAborted)
    let terminal = false
    let streaming = false
    const sendTerminal = async (event: Extract<ChatEvent, { type: 'done' | 'error' }>) => {
      if (terminal || controller.signal.aborted || response.destroyed) return
      terminal = true
      await writeEvent(response, controller.signal, event)
      if (!controller.signal.aborted && !response.destroyed) response.end()
    }

    try {
      const messages = await readMessages(request)
      if (controller.signal.aborted) return
      for await (const event of chat(messages, controller.signal)) {
        if (controller.signal.aborted || terminal) return
        if (!streaming) {
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
          streaming = true
        }
        if (event.type === 'delta') await writeEvent(response, controller.signal, event)
        else { await sendTerminal(event); return }
      }
      throw errors.incomplete()
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return
      const mapped = error instanceof ChatError ? error : upstreamError(error)
      if (!streaming) replyError(response, mapped)
      else await sendTerminal({ type: 'error', code: mapped.code, message: mapped.message })
    } finally {
      response.off('close', onClose)
      request.off('aborted', onRequestAborted)
    }
  }
}
