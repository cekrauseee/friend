import { loadEnv, type Plugin } from 'vite'
import { createLiveApi } from './live-api.ts'

/** Local backend, shared by the development server and production preview. */
export function liveApiPlugin(): Plugin {
  let handler: ReturnType<typeof createLiveApi>

  return {
    name: 'friend-live-api',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '')
      handler = createLiveApi(process.env.OPENAI_API_KEY || env.OPENAI_API_KEY)
    },
    configureServer(server) {
      server.middlewares.use('/api/session', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/session', handler)
    },
  }
}
