import { SILENT_BANDS } from './audio-meter.ts'
import { LiveSession } from './live-session.ts'
import { startElevenLabs } from './elevenlabs-conversation.ts'
import type { ElevenLabsConversation, StartElevenLabs } from './elevenlabs-conversation.ts'
import type { CallSnapshot } from './live-session.ts'

const IDLE: CallSnapshot = { status: 'idle', error: null, inputBands: SILENT_BANDS, outputLevel: 0 }

interface OpenAISession {
  getSnapshot: () => CallSnapshot
  subscribe: (listener: () => void) => () => void
  start: (context?: AudioContext) => Promise<void>
  end: () => void
  dispose: () => void
}

function startupError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'Allow microphone access in your browser, then try again.'
    if (error.name === 'NotFoundError') return 'Connect a microphone, then try again.'
    if (error.name === 'NotReadableError') return 'Your microphone is unavailable. Check other apps, then try again.'
  }
  // SDK errors can contain private connection details. Only our service errors
  // are shown directly, at the fetch boundary below.
  return 'Could not start the call. Please try again.'
}

/** Chooses one server-configured engine while retaining the UI's call contract. */
export class VoiceSession {
  #snapshot = IDLE
  #listeners = new Set<() => void>()
  #generation = 0
  #abort: AbortController | null = null
  #openAI: OpenAISession | null = null
  #unsubscribe: (() => void) | null = null
  #conversation: ElevenLabsConversation | null = null
  #closed = new WeakMap<ElevenLabsConversation, Promise<void>>()
  #sdkPending = false
  #deferredError: string | null = null
  #preparedContext: AudioContext | null = null
  #speaking = false
  #frame = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #lastSample: number | null = null
  #createOpenAI: () => OpenAISession
  #startElevenLabs: StartElevenLabs

  constructor(options: { createOpenAI?: () => OpenAISession; startElevenLabs?: StartElevenLabs } = {}) {
    this.#createOpenAI = options.createOpenAI ?? (() => new LiveSession())
    this.#startElevenLabs = options.startElevenLabs ?? startElevenLabs
  }

  getSnapshot = () => this.#snapshot
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(snapshot: CallSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #close(conversation: ElevenLabsConversation) {
    const pending = this.#closed.get(conversation)
    if (pending) return pending
    try { conversation.setMicMuted(true) } catch { /* Already disconnected. */ }
    try { conversation.setVolume({ volume: 0 }) } catch { /* Already disconnected. */ }
    let closing: Promise<void>
    try { closing = Promise.resolve(conversation.endSession()) }
    catch { closing = Promise.reject(new Error('Could not end the call.')) }
    this.#closed.set(conversation, closing)
    return closing
  }

  #cleanup() {
    ++this.#generation
    this.#abort?.abort()
    this.#abort = null
    clearTimeout(this.#timer)
    cancelAnimationFrame(this.#frame)
    this.#lastSample = null
    this.#speaking = false
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#openAI?.dispose()
    this.#openAI = null
    if (this.#conversation) void this.#close(this.#conversation).catch(() => {})
    this.#conversation = null
    if (this.#preparedContext) void this.#preparedContext.close().catch(() => {})
    this.#preparedContext = null
  }

  #fail(message: string) {
    const conversation = this.#conversation
    this.#cleanup()
    if (this.#sdkPending) {
      this.#deferredError = message
      this.#publish({ ...IDLE, status: 'closing' })
    } else if (conversation) {
      const generation = this.#generation
      this.#publish({ ...IDLE, status: 'closing' })
      void this.#close(conversation).catch(() => {}).then(() => {
        if (generation === this.#generation) this.#publish({ ...IDLE, status: 'error', error: message })
      })
    } else this.#publish({ ...IDLE, status: 'error', error: message })
  }

  async #request(path: string, signal: AbortSignal, method = 'GET') {
    const response = await fetch(path, { method, signal, cache: 'no-store' })
    const result = await response.json()
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Could not reach the voice service. Please try again.')
    return result
  }

  #sample = (time: number) => {
    if (this.#snapshot.status !== 'connected' || !this.#conversation) return
    if (this.#lastSample === null || time - this.#lastSample >= 1000 / 30) {
      const elapsed = this.#lastSample === null ? 1 / 30 : Math.max(0, (time - this.#lastSample) / 1000)
      this.#lastSample = time
      try {
        const frequencies = this.#conversation.getInputByteFrequencyData()
        const inputLevel = this.#conversation.getInputVolume()
        const bands = SILENT_BANDS.map((_, index) => {
          // SDK bins span the voice range; mirror low-to-high from center to edge.
          const distance = Math.abs(index - (SILENT_BANDS.length - 1) / 2)
          const bin = Math.min(frequencies.length - 1, Math.floor(distance / 16 * frequencies.length))
          const target = inputLevel > 0.01 ? Math.min(1, ((frequencies[bin] ?? 0) / 255) ** 1.5) : 0
          const current = this.#snapshot.inputBands[index]
          const duration = target > current ? 0.035 : 0.22
          const value = target + (current - target) * Math.exp(-elapsed / duration)
          return value < 0.002 ? 0 : value
        })
        const output = this.#speaking ? this.#conversation.getOutputVolume() : 0
        this.#publish({ ...this.#snapshot, inputBands: bands.every((band) => band === 0) ? SILENT_BANDS : bands,
          outputLevel: Number.isFinite(output) ? Math.max(0, Math.min(1, output)) : 0 })
      } catch {
        this.#fail('Audio was interrupted. Please start a new call.')
        return
      }
    }
    this.#frame = requestAnimationFrame(this.#sample)
  }

  start = async () => {
    if (this.#sdkPending || ['checking', 'connecting', 'connected', 'closing'].includes(this.#snapshot.status)) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.RTCPeerConnection) {
      this.#fail('Use a supported browser on HTTPS or localhost to start a call.')
      return
    }
    this.#cleanup()
    this.#deferredError = null
    const generation = ++this.#generation
    const current = () => generation === this.#generation
    const abort = new AbortController()
    this.#abort = abort
    // Preflight keeps the composer in place until the selected engine can start.
    this.#publish({ ...IDLE, status: 'checking' })
    this.#timer = setTimeout(() => this.#fail('The call took too long to connect. Please try again.'), 30_000)
    try {
      // Preserve OpenAI's gesture-time audio unlock while discovering the engine.
      this.#preparedContext = new window.AudioContext()
      void this.#preparedContext.resume().catch(() => {})
      let provider
      try { provider = await this.#request('/api/voice-provider', abort.signal) }
      catch (error) { if (current()) this.#fail(error instanceof Error ? error.message : 'Could not reach the voice service. Please try again.'); return }
      if (!current()) return
      if (provider?.provider === 'openai') {
        const engine = this.#createOpenAI()
        this.#openAI = engine
        this.#unsubscribe = engine.subscribe(() => { if (current()) this.#publish(engine.getSnapshot()) })
        clearTimeout(this.#timer)
        const context = this.#preparedContext!
        this.#preparedContext = null // Ownership transfers to the existing engine.
        this.#publish({ ...IDLE, status: 'connecting' })
        await engine.start(context)
        return
      }
      if (provider?.provider !== 'elevenlabs') throw new Error('Invalid voice provider.')
      await this.#preparedContext!.close()
      if (!current()) return
      this.#preparedContext = null
      let result
      try { result = await this.#request('/api/elevenlabs-session', abort.signal, 'POST') }
      catch (error) { if (current()) this.#fail(error instanceof Error ? error.message : 'Could not reach the voice service. Please try again.'); return }
      if (!current()) return
      if (result?.provider !== 'elevenlabs' || result.model !== 'eleven_v4_turbo'
        || typeof result.conversationToken !== 'string' || !result.conversationToken.trim()) throw new Error('Invalid conversation token.')
      this.#publish({ ...IDLE, status: 'connecting' })
      let owned: ElevenLabsConversation | null = null
      const retain = (conversation: ElevenLabsConversation) => {
        owned = conversation
        if (!current()) { void this.#close(conversation).catch(() => {}); return }
        this.#conversation = conversation
      }
      this.#sdkPending = true
      try {
        const conversation = await this.#startElevenLabs({
          conversationToken: result.conversationToken,
          connectionType: 'webrtc',
          onConversationCreated: retain,
          onConnect: () => { /* startSession resolution confirms the usable audio handle. */ },
          onDisconnect: ({ reason }) => {
            if (!current()) return
            if (reason === 'error') this.#fail('Connection lost. Please start a new call.')
            else { this.#cleanup(); this.#publish(IDLE) }
          },
          onError: () => { if (current()) this.#fail('The conversation could not continue. Please start a new call.') },
          onModeChange: ({ mode }) => {
            if (!current()) return
            this.#speaking = mode === 'speaking'
            if (!this.#speaking) this.#publish({ ...this.#snapshot, outputLevel: 0 })
          },
          onInterruption: () => {
            if (!current()) return
            this.#speaking = false
            this.#publish({ ...this.#snapshot, outputLevel: 0 })
          },
        })
        retain(conversation)
        if (!current()) return
        clearTimeout(this.#timer)
        this.#publish({ ...IDLE, status: 'connected' })
        this.#frame = requestAnimationFrame(this.#sample)
      } finally {
        // The public SDK has no startup abort handle. Keep microphone actions
        // excluded until its pending capture/transport and late handle settle.
        if (owned && !current()) await this.#close(owned).catch(() => {})
        this.#sdkPending = false
        if (!current() && this.#snapshot.status === 'closing') {
          this.#publish(this.#deferredError ? { ...IDLE, status: 'error', error: this.#deferredError } : IDLE)
          this.#deferredError = null
        }
      }
    } catch (error) {
      if (current()) this.#fail(startupError(error))
    }
  }

  end = () => {
    if (this.#snapshot.status === 'closing') return
    if (this.#openAI) { this.#openAI.end(); return }
    if (this.#sdkPending) { this.#cleanup(); this.#publish({ ...IDLE, status: 'closing' }); return }
    if (this.#snapshot.status !== 'connected' || !this.#conversation) { this.dispose(); return }
    const conversation = this.#conversation
    this.#conversation = null
    this.#cleanup()
    const generation = this.#generation
    this.#publish({ ...IDLE, status: 'closing' })
    this.#timer = setTimeout(() => this.#fail('The call ended before shutdown was confirmed.'), 15_000)
    void this.#close(conversation).then(() => {
      if (generation !== this.#generation) return
      clearTimeout(this.#timer)
      this.#publish(IDLE)
    }, () => { if (generation === this.#generation) this.#fail('The call ended before shutdown was confirmed.') })
  }

  dispose = () => {
    this.#cleanup()
    this.#deferredError = null
    this.#publish(this.#sdkPending ? { ...IDLE, status: 'closing' } : IDLE)
  }
  toggle = () => {
    if (['checking', 'connecting', 'connected'].includes(this.#snapshot.status)) this.end()
    else if (this.#snapshot.status !== 'closing') void this.start()
  }
}
