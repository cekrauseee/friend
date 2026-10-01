import OpenAI, { toFile } from 'openai'

export type TranscriptionProviderCode = 'access_denied' | 'rate_limited' | 'upstream_error'
  | 'empty_transcript' | 'timeout'

/** A completed, validated recording held only in memory by the local endpoint. */
export type TranscriptionRecording = { audio: Buffer; filename: string; mediaType: string }
export type TranscriptionProvider = {
  transcribe(recording: TranscriptionRecording, signal: AbortSignal): Promise<string>
}

/** Only safe, actionable provider failures cross the local endpoint boundary. */
export class TranscriptionProviderError extends Error {
  readonly status: number
  readonly code: TranscriptionProviderCode

  constructor(status: number, code: TranscriptionProviderCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function upstreamError() {
  return new TranscriptionProviderError(502, 'upstream_error',
    'Could not transcribe the recording. Please try again.')
}

function accessDenied(provider: string) {
  return new TranscriptionProviderError(503, 'access_denied', `${provider} access is not configured correctly.`)
}

function rateLimited() {
  return new TranscriptionProviderError(429, 'rate_limited',
    'The service is busy or your API limit was reached. Try again shortly.')
}

function transcript(result: unknown): string {
  const text = result && typeof result === 'object' && 'text' in result ? result.text : undefined
  if (typeof text !== 'string' || !text.trim()) throw new TranscriptionProviderError(
    502, 'empty_transcript', 'No speech was recognized. Please try again.')
  return text.trim()
}

export function createOpenAITranscriptionProvider(apiKey: string | undefined, client?: OpenAI): TranscriptionProvider | null {
  const openai = client ?? (apiKey?.trim()
    ? new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 }) : null)
  if (!openai) return null
  return {
    async transcribe({ audio, filename, mediaType }, signal) {
      try {
        const file = await toFile(audio, filename, { type: mediaType })
        signal.throwIfAborted()
        return transcript(await openai.audio.transcriptions.create({
          model: 'gpt-transcribe', file, response_format: 'json',
        }, { signal }))
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof TranscriptionProviderError) throw error
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new TranscriptionProviderError(
          504, 'timeout', 'Transcription took too long. Please try again.')
        if (error instanceof OpenAI.APIError) {
          if (error.status === 429) throw rateLimited()
          if (error.status === 401 || error.status === 403 || error.code === 'model_not_found') throw accessDenied('OpenAI')
        }
        throw upstreamError()
      }
    },
  }
}

/** Read only a bounded error code; provider messages are never returned or logged. */
async function elevenLabsErrorCode(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) return undefined
      chunks.push(value)
    }
    const error: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!error || typeof error !== 'object' || !('detail' in error)) return undefined
    const detail = error.detail
    return detail && typeof detail === 'object' && 'status' in detail ? detail.status : undefined
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createElevenLabsTranscriptionProvider(apiKey: string | undefined, fetcher: typeof fetch = fetch): TranscriptionProvider | null {
  if (!apiKey?.trim()) return null
  return {
    async transcribe({ audio, filename, mediaType }, signal) {
      signal.throwIfAborted()
      const form = new FormData()
      form.set('file', new Blob([new Uint8Array(audio)], { type: mediaType }), filename)
      form.set('model_id', 'scribe_v2')
      // Omit language_code to detect language; dictation needs neither event tags nor speakers.
      form.set('tag_audio_events', 'false')
      form.set('diarize', 'false')
      try {
        const response = await fetcher('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal,
        })
        if (!response.ok) {
          const code = response.status === 400 || response.status === 401
            ? await elevenLabsErrorCode(response) : undefined
          await response.body?.cancel().catch(() => {})
          if (code === 'quota_exceeded') throw rateLimited()
          if (response.status === 401 || response.status === 403) throw accessDenied('ElevenLabs')
          if (response.status === 429) throw rateLimited()
          if (response.status === 408 || response.status === 504) throw new TranscriptionProviderError(
            504, 'timeout', 'Transcription took too long. Please try again.')
          throw upstreamError()
        }
        return transcript(await response.json())
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (error instanceof TranscriptionProviderError) throw error
        throw upstreamError()
      }
    },
  }
}
