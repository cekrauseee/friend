import { loadEnv, type Plugin } from 'vite'
import { createLiveApi } from './live-api.ts'
import { createChatApi } from './chat-api.ts'
import { createProviderTranscriptionApi, createTranscriptionApi } from './transcription-api.ts'
import { createElevenLabsTranscriptionProvider } from './transcription-provider.ts'
import { createCodexProvider, createTextAccessApi } from './codex-provider.ts'

/** Local backend, shared by the development server and production preview. */
export function liveApiPlugin(): Plugin {
  let handler: ReturnType<typeof createLiveApi>
  let development = false
  let codex: ReturnType<typeof createCodexProvider> | undefined
  let accessHandler: ReturnType<typeof createTextAccessApi>
  let chatHandler: ReturnType<typeof createChatApi>
  let transcriptionHandler: ReturnType<typeof createTranscriptionApi>

  return {
    name: 'dot-live-api',
    closeBundle() { codex?.close() },
    config(_config, env) { development = env.command === 'serve' && !env.isPreview && env.mode === 'development' },
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '')
      const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY
      const transcriptionProvider = process.env.DOT_TRANSCRIPTION_PROVIDER ?? env.DOT_TRANSCRIPTION_PROVIDER ?? 'openai'
      if (transcriptionProvider !== 'openai' && transcriptionProvider !== 'elevenlabs') {
        throw new Error('DOT_TRANSCRIPTION_PROVIDER must be openai or elevenlabs.')
      }
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY ?? env.ELEVENLABS_API_KEY
      handler = createLiveApi(apiKey)
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
      chatHandler = createChatApi(codex ? undefined : apiKey, undefined, codex?.chat)
      accessHandler = createTextAccessApi(codex)
    },
    configureServer(server) {
      server.httpServer?.once('close', () => codex?.close())
      server.middlewares.use('/api/text-access', accessHandler)
      server.middlewares.use('/api/session', handler)
      server.middlewares.use('/api/chat', chatHandler)
      server.middlewares.use('/api/transcription', transcriptionHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/text-access', accessHandler)
      server.middlewares.use('/api/session', handler)
      server.middlewares.use('/api/chat', chatHandler)
      server.middlewares.use('/api/transcription', transcriptionHandler)
    },
  }
}
