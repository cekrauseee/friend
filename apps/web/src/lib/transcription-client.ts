import { apiPaths } from '@dot/contracts'
import { apiUrl } from './api-url.ts'
export type TranscriptionTransport = (audio: Blob, signal: AbortSignal) => Promise<string>

const fallback = 'Could not transcribe the recording. Check your connection and try again.'
const safeCodes = new Set([
  'invalid_request', 'request_too_large', 'unsupported_media_type', 'method_not_allowed',
  'forbidden_origin', 'not_configured', 'rate_limited', 'access_denied', 'upstream_error',
  'empty_transcript', 'timeout',
])

export class TranscriptionError extends Error {
  readonly code: string | null

  constructor(message = fallback, code: string | null = null) {
    super(message)
    this.name = 'TranscriptionError'
    this.code = code
  }
}

/** Upload only a completed recording; credentials and model selection stay on the server. */
export const transcribeAudio: TranscriptionTransport = async (audio, signal) => {
  try {
    const response = await fetch(apiUrl(apiPaths.transcription), {
      method: 'POST',
      headers: { 'Content-Type': audio.type },
      body: audio,
      signal,
    })
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new TranscriptionError()
    }
    const body: unknown = await response.json()
    if (!response.ok) {
      if (typeof body === 'object' && body !== null && 'error' in body) {
        const error = body.error
        if (typeof error === 'object' && error !== null &&
          'code' in error && typeof error.code === 'string' && safeCodes.has(error.code) &&
          'message' in error && typeof error.message === 'string' && error.message.trim()) {
          throw new TranscriptionError(error.message, error.code)
        }
      }
      throw new TranscriptionError()
    }
    if (typeof body !== 'object' || body === null || !('text' in body) ||
      typeof body.text !== 'string' || !body.text.trim()) {
      throw new TranscriptionError('No speech was detected. Record a new message and try again.', 'empty_transcript')
    }
    return body.text.trim()
  } catch (error) {
    if (error instanceof TranscriptionError) throw error
    throw new TranscriptionError()
  }
}
