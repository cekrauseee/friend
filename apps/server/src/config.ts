import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { voiceProvider } from './voice-api.ts'
import { speechEngineAddress } from './speech-engine-server.ts'

export type ServerMode = 'development' | 'production'
export type ServerConfig = ReturnType<typeof loadServerConfig>
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Load root configuration consistently from source and compiled output. */
export function loadServerConfig(options: { mode?: string; env?: NodeJS.ProcessEnv; root?: string } = {}) {
  const processEnv = options.env ?? process.env
  const mode = options.mode ?? processEnv.DOT_SERVER_MODE ?? 'production'
  if (mode !== 'development' && mode !== 'production') throw new Error('DOT_SERVER_MODE must be development or production.')
  const values: Record<string, string | undefined> = {}
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    try { Object.assign(values, parseEnv(readFileSync(resolve(options.root ?? repositoryRoot, name), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${name}. Check the root environment file permissions and format.`, { cause: error })
    }
  }
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) values[key] = value
  const textProvider = values.DOT_TEXT_PROVIDER || (mode === 'development' ? 'codex' : 'api')
  if (textProvider !== 'codex' && textProvider !== 'api') throw new Error('DOT_TEXT_PROVIDER must be codex or api.')
  if (mode !== 'development' && textProvider === 'codex') throw new Error('Codex text chat requires development mode. Set DOT_TEXT_PROVIDER=api for production.')
  const selectedVoice = voiceProvider(values.DOT_VOICE_PROVIDER)
  const transcriptionProvider = values.DOT_TRANSCRIPTION_PROVIDER ?? 'openai'
  if (transcriptionProvider !== 'openai' && transcriptionProvider !== 'elevenlabs') throw new Error('DOT_TRANSCRIPTION_PROVIDER must be openai or elevenlabs.')
  const host = values.DOT_API_HOST ?? '127.0.0.1'
  if (!isIP(host)) throw new Error('DOT_API_HOST must be an IP address (default 127.0.0.1).')
  const port = values.DOT_API_PORT ?? '3000'
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('DOT_API_PORT must be a port from 1 to 65535 (default 3000).')
  const frontendOrigins = (values.DOT_FRONTEND_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim())
  for (const origin of frontendOrigins) {
    try {
      const url = new URL(origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error()
    } catch { throw new Error('DOT_FRONTEND_ORIGINS must contain comma-separated HTTP(S) origins without paths, credentials or wildcards.') }
  }
  return {
    mode: mode as ServerMode, host, port: Number(port), frontendOrigins,
    textProvider, voiceProvider: selectedVoice, transcriptionProvider,
    openaiApiKey: values.OPENAI_API_KEY, elevenlabsApiKey: values.ELEVENLABS_API_KEY,
    elevenlabsSpeechEngineId: values.ELEVENLABS_SPEECH_ENGINE_ID,
    speechAddress: selectedVoice === 'elevenlabs'
      ? speechEngineAddress(values.DOT_SPEECH_ENGINE_HOST, values.DOT_SPEECH_ENGINE_PORT) : undefined,
  }
}
