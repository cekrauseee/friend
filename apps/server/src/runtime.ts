import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVoiceApis } from './voice-api.ts'
import { createChatApi } from './chat-api.ts'
import { createApiChatProvider, type ChatProvider } from './conversation-provider.ts'
import { createSpeechEngineAdmission } from './speech-engine-admission.ts'
import { createSpeechEngineServer } from './speech-engine-server.ts'
import { createProviderTranscriptionApi, createTranscriptionApi } from './transcription-api.ts'
import { createElevenLabsTranscriptionProvider } from './transcription-provider.ts'
import { createCodexProvider, createTextAccessApi } from './codex-provider.ts'
import type { ServerConfig } from './config.ts'

export type RuntimeHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export type RuntimeHandlers = Record<'chat' | 'textAccess' | 'voiceProvider' | 'openaiSession' | 'elevenlabsSession' | 'transcription', RuntimeHandler>
const defaultFactories = { createApiChatProvider, createCodexProvider, createSpeechEngineServer }

/** One cognition instance serves both transports; every active turn belongs to this runtime. */
export function createRuntime(config: ServerConfig, overrides: Partial<typeof defaultFactories> = {}) {
  const factories = { ...defaultFactories, ...overrides }
  const admission = createSpeechEngineAdmission()
  const active = new Set<AbortController>()
  let closed = false
  let closing: Promise<void> | undefined
  let codex: ReturnType<typeof createCodexProvider> | undefined
  let speech: ReturnType<typeof createSpeechEngineServer> | undefined
  const close = () => {
    closing ??= (async () => {
      closed = true
      for (const controller of active) controller.abort()
      admission.clear()
      try { await speech?.close() } finally { codex?.close() }
    })()
    return closing
  }
  try {
    if (config.textProvider === 'codex') codex = factories.createCodexProvider()
    const selected = codex?.chat ?? factories.createApiChatProvider(config.openaiApiKey)
    const provider: ChatProvider = async function* (messages, signal) {
      if (closed || signal.aborted) return
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      active.add(controller)
      try { yield* selected(messages, controller.signal) }
      finally { active.delete(controller); signal.removeEventListener('abort', abort) }
    }
    if (config.voiceProvider === 'elevenlabs' && config.elevenlabsApiKey && config.speechAddress) {
      speech = factories.createSpeechEngineServer({ apiKey: config.elevenlabsApiKey, provider, admission, ...config.speechAddress })
    }
    const voice = createVoiceApis({
      provider: config.voiceProvider, openaiApiKey: config.openaiApiKey,
      elevenlabsApiKey: config.elevenlabsApiKey, elevenlabsSpeechEngineId: config.elevenlabsSpeechEngineId,
      registerConversation: id => !closed && speech?.server.listening === true && admission.register(id),
    })
    const handlers: RuntimeHandlers = {
      chat: createChatApi(config.openaiApiKey, undefined, provider), textAccess: createTextAccessApi(codex),
      voiceProvider: voice.provider, openaiSession: voice.openaiSession, elevenlabsSession: voice.elevenlabsSession,
      transcription: config.transcriptionProvider === 'elevenlabs'
        ? createProviderTranscriptionApi(createElevenLabsTranscriptionProvider(config.elevenlabsApiKey), 'Dictation requires an ElevenLabs API key on the local server.')
        : createTranscriptionApi(config.openaiApiKey),
    }
    return { handlers, provider, admission, speech, close }
  } catch (error) {
    // No listener has started during construction. Release any allocated provider immediately.
    void close()
    throw error
  }
}
