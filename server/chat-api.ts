import type { IncomingMessage, ServerResponse } from 'node:http'
import OpenAI from 'openai'

const MAX_BODY_BYTES = 256 * 1024
const MAX_MESSAGES = 200
const MAX_CONTENT_BYTES = 32 * 1024

type ChatCode = 'invalid_request' | 'request_too_large' | 'unsupported_media_type'
  | 'method_not_allowed' | 'forbidden_origin' | 'not_configured'
  | 'rate_limited' | 'access_denied' | 'upstream_error' | 'incomplete_response'
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ChatEvent = { type: 'delta'; text: string } | { type: 'done' }
  | { type: 'error'; code: ChatCode; message: string }

export class ChatError extends Error {
  readonly status: number
  readonly code: ChatCode

  constructor(status: number, code: ChatCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const errors = {
  invalid: () => new ChatError(400, 'invalid_request', 'A valid text conversation is required.'),
  large: () => new ChatError(413, 'request_too_large', 'The conversation is too large. Start a new chat to continue.'),
  media: () => new ChatError(415, 'unsupported_media_type', 'Send the conversation as JSON.'),
  method: () => new ChatError(405, 'method_not_allowed', 'This endpoint accepts POST requests.'),
  origin: () => new ChatError(403, 'forbidden_origin', 'Requests must come from this local app.'),
  key: () => new ChatError(503, 'not_configured', 'Text chat is not configured yet.'),
  rate: () => new ChatError(429, 'rate_limited', 'The service is busy or your API limit was reached. Try again shortly.'),
  access: () => new ChatError(503, 'access_denied', 'OpenAI access is not configured correctly.'),
  upstream: () => new ChatError(502, 'upstream_error', 'Could not complete the reply. Please try again.'),
  incomplete: () => new ChatError(502, 'incomplete_response', 'Could not complete the reply. Please try again.'),
}

export function isLocalOrigin(request: IncomingMessage) {
  try {
    const origin = new URL(request.headers.origin ?? '')
    return ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      && ['http:', 'https:'].includes(origin.protocol)
      && origin.host === request.headers.host
  } catch {
    return false
  }
}

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

function upstreamError(error: unknown): ChatError {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return errors.rate()
    if (error.status === 401 || error.status === 403 || error.code === 'model_not_found') return errors.access()
  }
  return errors.upstream()
}

function eventError(event: { code?: unknown }): ChatError {
  if (event.code === 'rate_limit_exceeded') return errors.rate()
  if (event.code === 'invalid_api_key' || event.code === 'model_not_found') return errors.access()
  return errors.upstream()
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
export type ChatProvider = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatEvent>

export function createChatApi(apiKey: string | undefined, client?: OpenAI, provider?: ChatProvider) {
  const openai = client ?? (apiKey
    ? new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 })
    : null)

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') return replyError(response, errors.method())
    if (!isLocalOrigin(request)) return replyError(response, errors.origin())
    if (!openai && !provider) return replyError(response, errors.key())

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
      if (provider) {
        for await (const event of provider(messages, controller.signal)) {
          if (controller.signal.aborted || terminal) return
          if (!streaming) {
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' })
            streaming = true
          }
          if (event.type === 'delta') await writeEvent(response, controller.signal, event)
          else { await sendTerminal(event); return }
        }
        throw errors.incomplete()
      }
      const stream = await openai!.responses.create({
        model: 'gpt-6-luna',
        reasoning: { effort: 'none' },
        tools: [],
        tool_choice: 'none',
        input: messages,
        stream: true,
        store: false,
        max_output_tokens: 8192,
      }, { signal: controller.signal })
      if (controller.signal.aborted) return
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      streaming = true
      let emittedText = false
      for await (const event of stream) {
        if (controller.signal.aborted || terminal) return
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            emittedText = true
            await writeEvent(response, controller.signal, { type: 'delta', text: event.delta })
          }
        } else if (event.type === 'response.completed') {
          await sendTerminal(event.response.status === 'completed' && emittedText
            ? { type: 'done' }
            : { type: 'error', code: 'incomplete_response', message: errors.incomplete().message })
          return
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          await sendTerminal({ type: 'error', code: 'incomplete_response', message: errors.incomplete().message })
          return
        } else if (event.type === 'error') {
          const mapped = eventError(event)
          await sendTerminal({ type: 'error', code: mapped.code, message: mapped.message })
          return
        }
      }
      await sendTerminal({ type: 'error', code: 'incomplete_response', message: errors.incomplete().message })
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
