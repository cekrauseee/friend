import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLiveApi } from './live-api.ts'

export type VoiceProvider = 'openai' | 'elevenlabs'
export const ELEVENLABS_VOICE_MODEL = 'eleven_v4_turbo'
const MAX_UPSTREAM_BYTES = 1024 * 1024

export function voiceProvider(value: string | undefined): VoiceProvider {
  if (value === undefined || value === '') return 'openai'
  if (value === 'openai' || value === 'elevenlabs') return value
  throw new Error('DOT_VOICE_PROVIDER must be openai or elevenlabs.')
}

function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function allowed(request: IncomingMessage, response: ServerResponse, method: string) {
  if (request.method !== method) {
    response.setHeader('Allow', method)
    reply(response, 405, { error: `This endpoint accepts ${method} requests.` })
    return false
  }
  try {
    // Same-origin GET fetches omit Origin; browser Fetch Metadata supplies the boundary.
    if (method === 'GET' && !request.headers.origin && request.headers['sec-fetch-site'] === 'same-origin'
      && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname)) return true
    const origin = new URL(request.headers.origin ?? '')
    if (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      && ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.host) return true
  } catch { /* Missing and invalid origins are rejected. */ }
  reply(response, 403, { error: 'Calls must be started from this local app.' })
  return false
}

class VoiceError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
}

function hasAlternateVoice(tts: ObjectValue) {
  return Array.isArray(tts.supported_voices) && tts.supported_voices.some(voice => {
    const family = object(voice).model_family
    return family != null && family !== 'v4_turbo'
  })
}

/** Validate the existing immutable version; never change the hosted agent. */
function agentVersion(value: unknown, agentId: string): string {
  const agent = object(value)
  const config = object(agent.conversation_config)
  const prompt = object(object(config.agent).prompt)
  if (agent.agent_id !== agentId || object(config.tts).model_id !== ELEVENLABS_VOICE_MODEL
    || hasAlternateVoice(object(config.tts))) {
    throw new VoiceError(503, 'Configure the ElevenLabs agent with Eleven v4 Turbo (eleven_v4_turbo).')
  }
  if (typeof prompt.llm !== 'string' || !prompt.llm || prompt.llm === 'custom-llm' || prompt.custom_llm) {
    throw new VoiceError(503, 'Configure the ElevenLabs agent with a native LLM served through ElevenLabs.')
  }
  const events = object(config.conversation).client_events
  if (object(config.conversation).text_only === true
    || object(config.agent).disable_first_message_interruptions === true
    || !Array.isArray(events)
    || !['user_transcript', 'agent_response', 'agent_response_correction', 'interruption'].every(event => events.includes(event))) {
    throw new VoiceError(503, 'Enable audio, interruptions, and transcript events on the ElevenLabs agent.')
  }
  // A workflow can transfer to an unvalidated agent or override its speech engine.
  if (Object.keys(object(object(agent.workflow).nodes)).length) {
    throw new VoiceError(503, 'Use an ElevenLabs agent without workflows for this voice connection.')
  }
  for (const preset of Object.values(object(config.language_presets))) {
    const overrides = object(object(preset).overrides)
    const tts = object(overrides.tts)
    const presetAgent = object(overrides.agent)
    const presetPrompt = object(presetAgent.prompt)
    const conversation = object(overrides.conversation)
    if ((tts.model_id != null && tts.model_id !== ELEVENLABS_VOICE_MODEL)
      || hasAlternateVoice(tts)
      || presetPrompt.llm === 'custom-llm' || presetPrompt.custom_llm
      || presetAgent.disable_first_message_interruptions === true
      || conversation.text_only === true
      || (conversation.client_events != null && (!Array.isArray(conversation.client_events)
        || !['user_transcript', 'agent_response', 'agent_response_correction', 'interruption']
          .every(event => (conversation.client_events as unknown[]).includes(event))))) {
      throw new VoiceError(503, 'Keep Eleven v4 Turbo, a native LLM, audio and required events in ElevenLabs language presets.')
    }
  }
  if (typeof agent.version_id !== 'string' || !agent.version_id || agent.version_id.length > 256) {
    throw new VoiceError(503, 'Publish a version of the ElevenLabs agent before starting a call.')
  }
  return agent.version_id
}

async function upstreamJson(fetcher: typeof fetch, url: URL, key: string, signal: AbortSignal) {
  const response = await fetcher(url, { headers: { 'xi-api-key': key }, signal, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 429) throw new VoiceError(429, 'ElevenLabs is busy or your API limit was reached. Try again shortly.')
    if ([401, 403].includes(response.status)) throw new VoiceError(503, 'ElevenLabs access is not configured correctly.')
    if ([400, 404, 422].includes(response.status)) throw new VoiceError(503, 'The ElevenLabs agent or voice model is unavailable. Check the agent configuration.')
    throw new VoiceError(502, 'Could not start the ElevenLabs call. Please try again.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing upstream response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_UPSTREAM_BYTES) throw new Error('Upstream response too large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createVoiceApis(options: {
  provider: VoiceProvider
  openaiApiKey?: string
  elevenlabsApiKey?: string
  elevenlabsAgentId?: string
  fetch?: typeof fetch
  timeoutMs?: number
}) {
  const openai = createLiveApi(options.provider === 'openai' ? options.openaiApiKey : undefined)
  const configurationError = () => options.provider === 'openai'
    ? options.openaiApiKey?.trim() ? null : 'OpenAI voice requires OPENAI_API_KEY on the server.'
    : options.elevenlabsApiKey?.trim() && options.elevenlabsAgentId?.trim()
      ? null : 'ElevenLabs voice requires ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server.'
  return {
    provider(request: IncomingMessage, response: ServerResponse) {
      if (!allowed(request, response, 'GET')) return
      const error = configurationError()
      reply(response, error ? 503 : 200, error ? { error } : { provider: options.provider })
    },
    async openaiSession(request: IncomingMessage, response: ServerResponse) {
      if (options.provider === 'openai') return openai(request, response)
      if (allowed(request, response, 'POST')) reply(response, 409, { error: 'OpenAI voice is disabled. Restart the call using the selected voice provider.' })
    },
    async elevenlabsSession(request: IncomingMessage, response: ServerResponse) {
      if (!allowed(request, response, 'POST')) return
      if (options.provider !== 'elevenlabs') {
        reply(response, 409, { error: 'ElevenLabs voice is disabled. Restart the call using the selected voice provider.' })
        return
      }
      const key = options.elevenlabsApiKey
      const agentId = options.elevenlabsAgentId
      if (!key?.trim() || !agentId?.trim()) {
        reply(response, 503, { error: 'ElevenLabs voice requires ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID on the server.' })
        return
      }
      const controller = new AbortController()
      let disconnected = false
      const onClose = () => { if (!response.writableEnded) { disconnected = true; controller.abort() } }
      response.on('close', onClose)
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
      try {
        const fetcher = options.fetch ?? fetch
        const agentUrl = new URL(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`)
        const version = agentVersion(await upstreamJson(fetcher, agentUrl, key, controller.signal), agentId)
        if (controller.signal.aborted) throw new Error('Aborted')
        const tokenUrl = new URL('https://api.elevenlabs.io/v1/convai/conversation/token')
        tokenUrl.searchParams.set('agent_id', agentId)
        tokenUrl.searchParams.set('version_id', version)
        const result = object(await upstreamJson(fetcher, tokenUrl, key, controller.signal))
        if (typeof result.token !== 'string' || !result.token || result.token.length > 32 * 1024) throw new Error('Invalid token')
        if (!controller.signal.aborted) reply(response, 201, {
          provider: 'elevenlabs', model: ELEVENLABS_VOICE_MODEL, conversationToken: result.token,
        })
      } catch (error) {
        if (disconnected) return
        if (controller.signal.aborted) reply(response, 504, { error: 'ElevenLabs took too long to start the call. Please try again.' })
        else if (error instanceof VoiceError) reply(response, error.status, { error: error.message })
        else reply(response, 502, { error: 'Could not start the ElevenLabs call. Please try again.' })
      } finally {
        clearTimeout(timer)
        response.off('close', onClose)
      }
    },
  }
}
