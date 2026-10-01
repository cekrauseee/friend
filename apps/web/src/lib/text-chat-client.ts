import type { ChatMessage } from '@dot/contracts'
export type { ChatMessage } from '@dot/contracts'

export type TextChatTransport = (
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
) => Promise<void>

const genericError = 'Could not complete the reply. Please try again.'

const safeCodes = new Set([
  'invalid_request',
  'request_too_large',
  'unsupported_media_type',
  'method_not_allowed',
  'forbidden_origin',
  'not_configured',
  'rate_limited',
  'access_denied',
  'upstream_error',
  'incomplete_response',
])

export class TextChatError extends Error {
  readonly code: string | null

  constructor(message = genericError, code: string | null = null) {
    super(message)
    this.name = 'TextChatError'
    this.code = code
  }
}

function serviceError(value: unknown): TextChatError {
  if (
    typeof value === 'object' && value !== null &&
    'code' in value && typeof value.code === 'string' && safeCodes.has(value.code) &&
    'message' in value && typeof value.message === 'string' && value.message.trim()
  ) {
    return new TextChatError(value.message, value.code)
  }
  return new TextChatError()
}

function parseEvent(line: string): { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; code: string; message: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new TextChatError()
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new TextChatError()
  }
  if (value.type === 'delta' && 'text' in value && typeof value.text === 'string') {
    return { type: 'delta', text: value.text }
  }
  if (value.type === 'done') return { type: 'done' }
  if (value.type === 'error') {
    const error = serviceError(value)
    return { type: 'error', code: error.code ?? '', message: error.message }
  }
  throw new TextChatError()
}

export const sendTextChat: TextChatTransport = async (messages, signal, onDelta) => {
  let response: Response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    })
  } catch {
    throw new TextChatError()
  }

  if (!response.ok) {
    let body: unknown
    try {
      if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        body = await response.json()
      }
    } catch {
      throw new TextChatError()
    }
    if (typeof body === 'object' && body !== null && 'error' in body) {
      throw serviceError(body.error)
    }
    throw new TextChatError()
  }

  if (!/^application\/x-ndjson(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
    throw new TextChatError()
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let terminal = false
  let receivedText = false

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) throw new TextChatError()
    const event = parseEvent(line)
    if (event.type === 'delta') {
      if (event.text) receivedText = true
      onDelta(event.text)
    } else if (event.type === 'error') {
      terminal = true
      throw new TextChatError(event.message, event.code || null)
    } else {
      if (!receivedText) throw new TextChatError()
      terminal = true
    }
  }

  try {
    while (!terminal) {
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        if (buffer) processLine(buffer)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !terminal) {
        processLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    if (!terminal) throw new TextChatError()
  } catch (error) {
    if (error instanceof TextChatError) throw error
    throw new TextChatError()
  } finally {
    if (terminal) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
