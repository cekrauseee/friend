import type { IncomingMessage, ServerResponse } from 'node:http'
import type OpenAI from 'openai'
import { createOpenAITranscriptionProvider, TranscriptionProviderError, type TranscriptionProvider } from './transcription-provider.ts'
import { isLocalOrigin } from './chat-api.ts'

const MAX_AUDIO_BYTES = 25_000_000
const REQUEST_TIMEOUT_MS = 120_000

type TranscriptionCode = 'invalid_request' | 'request_too_large' | 'unsupported_media_type'
  | 'method_not_allowed' | 'forbidden_origin' | 'not_configured' | 'rate_limited'
  | 'access_denied' | 'upstream_error' | 'empty_transcript' | 'timeout'
export type TranscriptionResponse = { text: string }
export type TranscriptionFailure = { error: { code: TranscriptionCode; message: string } }

class TranscriptionError extends Error {
  readonly status: number
  readonly code: TranscriptionCode

  constructor(status: number, code: TranscriptionCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function reply(response: ServerResponse, status: number, body: TranscriptionResponse | TranscriptionFailure) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(status === 405 ? { Allow: 'POST' } : {}),
  })
  response.end(JSON.stringify(body))
}

function replyError(response: ServerResponse, error: TranscriptionError | TranscriptionProviderError) {
  reply(response, error.status, { error: { code: error.code, message: error.message } })
}

function invalid() {
  return new TranscriptionError(400, 'invalid_request', 'Send a completed audio recording.')
}

function tooLarge() {
  return new TranscriptionError(413, 'request_too_large', 'The recording exceeds the 25 MB limit. Record a shorter message.')
}

/** Collect only a bounded raw recording; never persist audio on the server. */
function readAudio(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const length = request.headers['content-length']
  if (length !== undefined) {
    if (!/^\d+$/.test(length)) throw invalid()
    if (Number(length) > MAX_AUDIO_BYTES) throw tooLarge()
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: unknown) => { cleanup(); request.pause(); reject(error) }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_AUDIO_BYTES) return fail(tooLarge())
      chunks.push(buffer)
    }
    const onEnd = () => {
      cleanup()
      if (size === 0 || (length !== undefined && size !== Number(length))) reject(invalid())
      else resolve(Buffer.concat(chunks, size))
    }
    const onError = () => fail(invalid())
    const onAbort = () => fail(signal.reason)
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** POST a completed WebM/MP4 Blob. The browser controls recording, not model settings. */
export function createTranscriptionApi(apiKey: string | undefined, client?: OpenAI) {
  return createProviderTranscriptionApi(createOpenAITranscriptionProvider(apiKey, client),
    'Dictation requires an OpenAI API key on the local server.')
}

/** Shared local recording boundary; provider selection never changes the browser contract. */
export function createProviderTranscriptionApi(provider: TranscriptionProvider | null, notConfiguredMessage: string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') return replyError(response,
      new TranscriptionError(405, 'method_not_allowed', 'This endpoint accepts POST requests.'))
    if (!isLocalOrigin(request)) return replyError(response,
      new TranscriptionError(403, 'forbidden_origin', 'Requests must come from this local app.'))
    const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
    const webm = mediaType === 'audio/webm'
    if (!webm && mediaType !== 'audio/mp4' && mediaType !== 'video/mp4') return replyError(response,
      new TranscriptionError(415, 'unsupported_media_type', 'Send a WebM or MP4 audio recording.'))
    if (!provider) return replyError(response,
      new TranscriptionError(503, 'not_configured', notConfiguredMessage))

    const controller = new AbortController()
    const timeoutError = new TranscriptionError(504, 'timeout', 'Transcription took too long. Please try again.')
    const timer = setTimeout(() => controller.abort(timeoutError), REQUEST_TIMEOUT_MS)
    const onClose = () => { if (!response.writableEnded) controller.abort() }
    const onAborted = () => controller.abort()
    response.on('close', onClose)
    request.on('aborted', onAborted)
    let onAbort: () => void = () => {}
    try {
      if (request.aborted || response.destroyed) controller.abort()
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      })
      const transcribe = async () => {
        const audio = await readAudio(request, controller.signal)
        // Container signatures catch malformed bodies without decoding or transcoding audio.
        const valid = webm
          ? audio.length > 4 && audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          : audio.length >= 12 && audio.toString('ascii', 4, 8) === 'ftyp'
        if (!valid) throw invalid()
        if (controller.signal.aborted) throw controller.signal.reason
        const text = await provider.transcribe({
          audio, filename: webm ? 'recording.webm' : 'recording.mp4', mediaType,
        }, controller.signal)
        return { text }
      }
      const result = await Promise.race([transcribe(), aborted])
      if (!controller.signal.aborted) reply(response, 200, result)
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== timeoutError) return
      const mapped = error instanceof TranscriptionError || error instanceof TranscriptionProviderError
        ? error : new TranscriptionError(502, 'upstream_error',
          'Could not transcribe the recording. Please try again.')
      replyError(response, mapped)
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      response.off('close', onClose)
      request.off('aborted', onAborted)
    }
  }
}
