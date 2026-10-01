import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const ISSUER = 'https://api.elevenlabs.io/convai/speech-engine'
const SUBJECT = 'convai_speech_engine_upstream'

/** Official upstream JWT: HS256 with the binary SHA256 API-key digest, 60s leeway. */
export function verifySpeechEngineAuthorization(token: unknown, apiKey: string, now = Date.now()): boolean {
  if (typeof token !== 'string' || !apiKey || token.length > 8192) return false
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false
  try {
    const [header, payload, signature] = parts
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    if (decodedHeader.alg !== 'HS256' || decodedHeader.crit !== undefined) return false
    const expected = createHmac('sha256', createHash('sha256').update(apiKey).digest())
      .update(`${header}.${payload}`).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const seconds = now / 1000
    return claims.iss === ISSUER && claims.sub === SUBJECT
      && typeof claims.exp === 'number' && Number.isFinite(claims.exp) && seconds < claims.exp + 60
      && (claims.nbf === undefined || (typeof claims.nbf === 'number'
        && Number.isFinite(claims.nbf) && seconds + 60 >= claims.nbf))
  } catch { return false }
}
