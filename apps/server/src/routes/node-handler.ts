import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import type { HttpBindings } from '@hono/node-server'
import type { Context } from 'hono'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiPaths } from '@dot/contracts'
import { withAuthorizedOrigin } from '../origin-policy.ts'

export type NodeHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export type ApiContext = Context<{ Bindings: HttpBindings }>

/** Do not read the body or wrap the response: Node retains streaming and cancellation. */
export async function nodeHandler(context: ApiContext, handler: NodeHandler, suffix?: string) {
  const { incoming, outgoing } = context.env
  const originalUrl = incoming.url
  if (suffix !== undefined) incoming.url = suffix
  try {
    await withAuthorizedOrigin(incoming, () => handler(incoming, outgoing))
  } catch {
    if (outgoing.headersSent) outgoing.destroy()
    else if (!outgoing.destroyed && !outgoing.writableEnded) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      const message = 'The request could not be completed.'
      const structured = context.req.path === apiPaths.chat || context.req.path === apiPaths.transcription
        || context.req.path.startsWith('/api/text-access/')
      outgoing.end(JSON.stringify({ error: structured ? { code: 'upstream_error', message } : message }))
    }
  } finally { incoming.url = originalUrl }
  return RESPONSE_ALREADY_SENT
}
