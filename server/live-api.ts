import type { IncomingMessage, ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { sessionConfig } from './session-config.ts'

const MAX_BODY_BYTES = 64 * 1024

class RequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function isLocalOrigin(request: IncomingMessage) {
  try {
    const origin = new URL(request.headers.origin ?? '')
    return ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      && ['http:', 'https:'].includes(origin.protocol)
      && origin.host === request.headers.host
  } catch {
    return false
  }
}

async function readOffer(request: IncomingMessage): Promise<string> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(415, 'Expected a JSON session request.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'The session request is too large.')
    chunks.push(buffer)
  }

  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'The session request is invalid.')
  }
  if (!body || typeof body !== 'object' || !('sdp' in body)
    || typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) {
    throw new RequestError(400, 'A valid connection offer is required.')
  }
  return body.sdp
}

export function createLiveApi(apiKey: string | undefined, client?: OpenAI) {
  const openai = client ?? (apiKey
    ? new OpenAI({ apiKey, maxRetries: 0, timeout: 20_000 })
    : null)

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      reply(response, 405, { error: 'This endpoint accepts POST requests.' })
      return
    }
    if (!isLocalOrigin(request)) {
      reply(response, 403, { error: 'Calls must be started from this local app.' })
      return
    }
    if (!openai) {
      reply(response, 503, { error: 'Voice calls are not configured yet.' })
      return
    }

    const controller = new AbortController()
    const onClose = () => {
      if (!response.writableEnded) controller.abort()
    }
    response.on('close', onClose)

    try {
      const sdp = await readOffer(request)
      const result = await openai.live.create({
        session: sessionConfig,
        transport: { type: 'webrtc', sdp },
      }, { signal: controller.signal })
      reply(response, 201, {
        session: { id: result.session.id },
        transport: { type: 'webrtc', sdp: result.transport.sdp },
      })
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof RequestError) {
        reply(response, error.status, { error: error.message })
      } else if (error instanceof OpenAI.APIError && error.status === 429) {
        reply(response, 429, { error: 'OpenAI is busy or your API limit was reached. Try again shortly.' })
      } else if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) {
        reply(response, 503, { error: 'OpenAI access is not configured correctly.' })
      } else {
        reply(response, 502, { error: 'Could not start the call. Please try again.' })
      }
    } finally {
      response.off('close', onClose)
    }
  }
}
