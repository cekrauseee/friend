import { Hono } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import { apiPaths } from '@dot/contracts'
import type { RuntimeHandlers } from './runtime.ts'
import type { ServerMode } from './config.ts'
import { isLoopbackOrigin, validFrontendOrigin } from './origin-policy.ts'
import { nodeHandler, type ApiContext } from './routes/node-handler.ts'

const methods = new Map<string, string>([
  [apiPaths.health, 'GET'], [apiPaths.chat, 'POST'],
  ...Object.values(apiPaths.textAccess).map(path => [path, 'POST'] as [string, string]),
  [apiPaths.voiceProvider, 'GET'], [apiPaths.session, 'POST'],
  [apiPaths.elevenlabsSession, 'POST'], [apiPaths.transcription, 'POST'],
])

function error(context: ApiContext, status: 403 | 405, code: string, message: string) {
  context.header('Cache-Control', 'no-store')
  if (context.req.path === apiPaths.chat || context.req.path === apiPaths.transcription
    || Object.values(apiPaths.textAccess).some(path => path === context.req.path)) {
    return context.json({ error: { code, message } }, status)
  }
  return context.json({ error: message }, status)
}

export function createApp(handlers: RuntimeHandlers, options: { frontendOrigins: string[]; mode: ServerMode }) {
  if (!options.frontendOrigins.length || options.frontendOrigins.some(origin => !validFrontendOrigin(origin))) {
    throw new Error('Frontend origins must be exact HTTP or HTTPS origins.')
  }
  const origins = new Set(options.frontendOrigins)
  const app = new Hono<{ Bindings: HttpBindings }>()
  app.use('/api/*', async (context, next) => {
    const method = methods.get(context.req.path)
    if (!method) return next()
    const origin = context.req.header('Origin')
    const originAllowed = origin !== undefined && origins.has(origin)
    const discoveryAllowed = origin === undefined && context.req.method === 'GET'
      && (context.req.path === apiPaths.health || context.req.header('Sec-Fetch-Site') === 'same-origin')
    const authAction = context.req.path === apiPaths.textAccess.login || context.req.path === apiPaths.textAccess.cancel
    const socketLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(context.env.incoming.socket.remoteAddress ?? '')
    if ((!originAllowed && !discoveryAllowed) || (authAction
      && (options.mode !== 'development' || !origin || !isLoopbackOrigin(origin) || !socketLocal))) {
      return error(context, 403, 'forbidden_origin', 'Requests must come from an allowed app origin.')
    }
    if (originAllowed) {
      // Raw handlers write directly to outgoing; Hono response headers are not used for them.
      context.env.outgoing.setHeader('Access-Control-Allow-Origin', origin!)
      context.env.outgoing.setHeader('Vary', 'Origin')
      context.header('Access-Control-Allow-Origin', origin!)
      context.header('Vary', 'Origin')
    }
    if (context.req.method === 'OPTIONS') {
      const requestedMethod = context.req.header('Access-Control-Request-Method')
      const requestedHeaders = (context.req.header('Access-Control-Request-Headers') ?? '')
        .split(',').map(header => header.trim().toLowerCase()).filter(Boolean)
      if (requestedMethod !== method || requestedHeaders.some(header => header !== 'content-type')) {
        return error(context, 403, 'forbidden_origin', 'The requested cross-origin operation is not allowed.')
      }
      context.header('Access-Control-Allow-Methods', method)
      if (requestedHeaders.length) context.header('Access-Control-Allow-Headers', 'Content-Type')
      context.header('Cache-Control', 'no-store')
      return context.body(null, 204)
    }
    if (context.req.method !== method) {
      context.header('Allow', method)
      return error(context, 405, 'method_not_allowed', `This endpoint accepts ${method} requests.`)
    }
    return next()
  })
  app.get(apiPaths.health, context => {
    context.header('Cache-Control', 'no-store')
    return context.json({ ready: true })
  })
  const chat = new Hono<{ Bindings: HttpBindings }>()
  chat.post('/chat', context => nodeHandler(context, handlers.chat))
  for (const [action, path] of Object.entries(apiPaths.textAccess)) {
    chat.post(path.slice('/api'.length), context => nodeHandler(context, handlers.textAccess, `/${action}`))
  }
  const voice = new Hono<{ Bindings: HttpBindings }>()
  voice.get('/voice-provider', context => nodeHandler(context, handlers.voiceProvider))
  voice.post('/session', context => nodeHandler(context, handlers.openaiSession))
  voice.post('/elevenlabs-session', context => nodeHandler(context, handlers.elevenlabsSession))
  const transcription = new Hono<{ Bindings: HttpBindings }>()
  transcription.post('/transcription', context => nodeHandler(context, handlers.transcription))
  app.route('/api', chat)
  app.route('/api', voice)
  app.route('/api', transcription)
  return app
}
