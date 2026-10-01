/** Public HTTP paths shared by the browser transport and standalone API. */
export const apiPaths = {
  health: '/api/health',
  chat: '/api/chat',
  textAccess: {
    status: '/api/text-access/status',
    login: '/api/text-access/login',
    cancel: '/api/text-access/cancel',
  },
  voiceProvider: '/api/voice-provider',
  session: '/api/session',
  elevenlabsSession: '/api/elevenlabs-session',
  transcription: '/api/transcription',
} as const

export type TextAccessAction = keyof typeof apiPaths.textAccess
export type ApiPath = Exclude<typeof apiPaths[keyof typeof apiPaths], object>
  | typeof apiPaths.textAccess[TextAccessAction]

export type ChatCode = 'invalid_request' | 'request_too_large' | 'unsupported_media_type'
  | 'method_not_allowed' | 'forbidden_origin' | 'not_configured'
  | 'rate_limited' | 'access_denied' | 'upstream_error' | 'incomplete_response'
export type ChatMessage = { role: 'user' | 'assistant'; content: string }
export type ChatRequest = { messages: ChatMessage[] }
/** One NDJSON record; done and error both terminate the stream. */
export type ChatEvent = { type: 'delta'; text: string } | { type: 'done' }
  | { type: 'error'; code: ChatCode; message: string }
export type ChatFailure = { error: { code: ChatCode; message: string } }

export type CognitiveProvider = 'api' | 'codex'
export type TextAccessState = { id: string; state: 'pending' | 'succeeded' | 'failed'; message?: string }
export type TextAccessStatus = { provider: CognitiveProvider; authenticated: boolean; login: TextAccessState | null }
export type TextAccessLoginResponse = { loginId: string; authUrl: string }
export type TextAccessCancelResponse = { canceled: true }

export type VoiceProvider = 'openai' | 'elevenlabs'
export type VoiceProviderResponse = { provider: VoiceProvider }
export type SessionRequest = { sdp: string }
export type SessionResponse = { session: { id: string }; transport: { type: 'webrtc'; sdp: string } }
export type ElevenLabsSessionResponse = { provider: 'elevenlabs'; model: 'eleven_v4_turbo'; conversationToken: string }
/** Voice/session routes retain their existing string error body. */
export type ServiceFailure = { error: string }

export type TranscriptionCode = 'invalid_request' | 'request_too_large' | 'unsupported_media_type'
  | 'method_not_allowed' | 'forbidden_origin' | 'not_configured' | 'rate_limited'
  | 'access_denied' | 'upstream_error' | 'empty_transcript' | 'timeout'
export type TranscriptionResponse = { text: string }
export type TranscriptionFailure = { error: { code: TranscriptionCode; message: string } }
