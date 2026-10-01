import { loadEnv, type Plugin } from 'vite'
import { createVoiceApis, voiceProvider } from './voice-api.ts'
import { createChatApi } from './chat-api.ts'
import { createApiChatProvider } from './conversation-provider.ts'
import { createSpeechEngineAdmission } from './speech-engine-admission.ts'
import { createSpeechEngineServer, speechEngineAddress } from './speech-engine-server.ts'
import { createProviderTranscriptionApi, createTranscriptionApi } from './transcription-api.ts'
import { createElevenLabsTranscriptionProvider } from './transcription-provider.ts'
import { createCodexProvider, createTextAccessApi } from './codex-provider.ts'

/** Local backend, shared by the development server and production preview. */
export function liveApiPlugin(): Plugin {
  let voice: ReturnType<typeof createVoiceApis>
  let development = false
  let speech: ReturnType<typeof createSpeechEngineServer> | undefined
  const admission = createSpeechEngineAdmission()
  const close = async () => {
    await speech?.close()
    admission.clear()
    codex?.close()
  }
  let codex: ReturnType<typeof createCodexProvider> | undefined
  let accessHandler: ReturnType<typeof createTextAccessApi>
  let chatHandler: ReturnType<typeof createChatApi>
  let transcriptionHandler: ReturnType<typeof createTranscriptionApi>

  return {
    name: 'dot-live-api',
    closeBundle: close,
    config(_config, env) { development = env.command === 'serve' && !env.isPreview && env.mode === 'development' },
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '')
      const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY
      const transcriptionProvider = process.env.DOT_TRANSCRIPTION_PROVIDER ?? env.DOT_TRANSCRIPTION_PROVIDER ?? 'openai'
      if (transcriptionProvider !== 'openai' && transcriptionProvider !== 'elevenlabs') {
        throw new Error('DOT_TRANSCRIPTION_PROVIDER must be openai or elevenlabs.')
      }
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY ?? env.ELEVENLABS_API_KEY
      transcriptionHandler = transcriptionProvider === 'elevenlabs'
        ? createProviderTranscriptionApi(createElevenLabsTranscriptionProvider(elevenLabsKey),
          'Dictation requires an ElevenLabs API key on the local server.')
        : createTranscriptionApi(apiKey)
      const provider = process.env.DOT_TEXT_PROVIDER || env.DOT_TEXT_PROVIDER || (development ? 'codex' : 'api')
      if (!['codex', 'api'].includes(provider)) throw new Error('DOT_TEXT_PROVIDER must be codex or api.')
      if (!development && config.command === 'serve' && provider === 'codex') {
        throw new Error('Codex text chat requires pnpm dev in development mode. Set DOT_TEXT_PROVIDER=api for preview.')
      }
      if (development && provider === 'codex') codex = createCodexProvider()
      const conversationProvider = codex?.chat ?? createApiChatProvider(apiKey)
      chatHandler = createChatApi(apiKey, undefined, conversationProvider)
      const selectedVoice = voiceProvider(process.env.DOT_VOICE_PROVIDER ?? env.DOT_VOICE_PROVIDER)
      if (selectedVoice === 'elevenlabs') {
        const address = speechEngineAddress(
          process.env.DOT_SPEECH_ENGINE_HOST ?? env.DOT_SPEECH_ENGINE_HOST,
          process.env.DOT_SPEECH_ENGINE_PORT ?? env.DOT_SPEECH_ENGINE_PORT,
        )
        if (elevenLabsKey) speech = createSpeechEngineServer({
          apiKey: elevenLabsKey, provider: conversationProvider, admission, ...address,
        })
      }
      voice = createVoiceApis({
        provider: selectedVoice,
        openaiApiKey: apiKey,
        elevenlabsApiKey: elevenLabsKey,
        elevenlabsSpeechEngineId: process.env.ELEVENLABS_SPEECH_ENGINE_ID ?? env.ELEVENLABS_SPEECH_ENGINE_ID,
        registerConversation: (id) => speech?.server.listening === true && admission.register(id),
      })
      accessHandler = createTextAccessApi(codex)
    },
    async configureServer(server) {
      server.httpServer?.once('close', () => { void close() })
      if (server.httpServer) await speech?.listen()
      server.middlewares.use('/api/text-access', accessHandler)
      server.middlewares.use('/api/voice-provider', voice.provider)
      server.middlewares.use('/api/elevenlabs-session', voice.elevenlabsSession)
      server.middlewares.use('/api/session', voice.openaiSession)
      server.middlewares.use('/api/chat', chatHandler)
      server.middlewares.use('/api/transcription', transcriptionHandler)
    },
    async configurePreviewServer(server) {
      server.httpServer?.once('close', () => { void close() })
      if (server.httpServer) await speech?.listen()
      server.middlewares.use('/api/text-access', accessHandler)
      server.middlewares.use('/api/voice-provider', voice.provider)
      server.middlewares.use('/api/elevenlabs-session', voice.elevenlabsSession)
      server.middlewares.use('/api/session', voice.openaiSession)
      server.middlewares.use('/api/chat', chatHandler)
      server.middlewares.use('/api/transcription', transcriptionHandler)
    },
  }
}
