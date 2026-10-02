import OpenAI from 'openai'
import { conversationConfig } from './conversation-config.ts'

import type { ChatCode, ChatMessage, ChatEvent } from '@dot/contracts'
export type { ChatCode, ChatMessage, ChatEvent } from '@dot/contracts'

export class ChatError extends Error {
  readonly status: number
  readonly code: ChatCode

  constructor(status: number, code: ChatCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const conversationErrors = {
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


export function upstreamError(error: unknown): ChatError {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return conversationErrors.rate()
    if (error.status === 401 || error.status === 403 || error.code === 'model_not_found') return conversationErrors.access()
  }
  return conversationErrors.upstream()
}

function eventError(event: { code?: unknown }): ChatError {
  if (event.code === 'rate_limit_exceeded') return conversationErrors.rate()
  if (event.code === 'invalid_api_key' || event.code === 'model_not_found') return conversationErrors.access()
  return conversationErrors.upstream()
}

/** A transport-independent stream over the full accepted conversation history. */
export type ChatProvider = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<ChatEvent>

/** Create the stateless Responses provider used by text and speech transports. */
export function createApiChatProvider(apiKey: string | undefined, client?: OpenAI): ChatProvider {
  const openai = client ?? (apiKey
    ? new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 })
    : null)

  return async function* (messages, signal) {
    if (signal.aborted) return
    if (!openai) throw conversationErrors.key()
    let stream
    try {
      stream = await openai.responses.create({
        ...conversationConfig,
        input: messages,
        stream: true,
        store: false,
      }, { signal })
    } catch (error) {
      if (signal.aborted) return
      throw upstreamError(error)
    }
    if (signal.aborted) return
    let emittedText = false
    const errorEvent = (error: ChatError): ChatEvent => ({ type: 'error', code: error.code, message: error.message })
    try {
      for await (const event of stream) {
        if (signal.aborted) return
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            emittedText = true
            yield { type: 'delta', text: event.delta }
          }
        } else if (event.type === 'response.completed') {
          yield event.response.status === 'completed' && emittedText
            ? { type: 'done' }
            : errorEvent(conversationErrors.incomplete())
          return
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          yield errorEvent(conversationErrors.incomplete())
          return
        } else if (event.type === 'error') {
          yield errorEvent(eventError(event))
          return
        }
      }
      if (!signal.aborted) yield errorEvent(conversationErrors.incomplete())
    } catch (error) {
      if (!signal.aborted) yield errorEvent(upstreamError(error))
    }
  }
}
