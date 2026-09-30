import { loadEnv, type Plugin } from 'vite'
import { createLiveApi } from './live-api.ts'
import { createChatApi } from './chat-api.ts'

/** Local backend, shared by the development server and production preview. */
export function liveApiPlugin(): Plugin {
  let handler: ReturnType<typeof createLiveApi>
  let chatHandler: ReturnType<typeof createChatApi>

  return {
    name: 'friend-live-api',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '')
      const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY
      handler = createLiveApi(apiKey)
      chatHandler = createChatApi(apiKey)
    },
    configureServer(server) {
      server.middlewares.use('/api/session', handler)
      server.middlewares.use('/api/chat', chatHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/session', handler)
      server.middlewares.use('/api/chat', chatHandler)
    },
  }
}
