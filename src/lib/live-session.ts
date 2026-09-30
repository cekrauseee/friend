import { AudioMeter, SILENT_BANDS } from './audio-meter.ts'
import { waitForIce } from './webrtc.ts'

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'closing' | 'error'

export interface CallSnapshot {
  status: CallStatus
  error: string | null
  inputBands: number[]
  outputLevel: number
}

const IDLE: CallSnapshot = {
  status: 'idle', error: null, inputBands: SILENT_BANDS, outputLevel: 0,
}

function startError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Allow microphone access in your browser, then try again.'
    }
    if (error.name === 'NotFoundError') return 'Connect a microphone, then try again.'
    if (error.name === 'NotReadableError') return 'Your microphone is unavailable. Check other apps, then try again.'
  }
  if (error instanceof TypeError || error instanceof SyntaxError) {
    return 'Could not reach the voice service. Please try again.'
  }
  return error instanceof Error ? error.message : 'Could not start the call. Please try again.'
}

/** Owns one call. React components only observe its state and invoke start/end. */
export class LiveSession {
  #snapshot = IDLE
  #listeners = new Set<() => void>()
  #generation = 0
  #abort: AbortController | null = null
  #context: AudioContext | null = null
  #microphone: MediaStream | null = null
  #peer: RTCPeerConnection | null = null
  #events: RTCDataChannel | null = null
  #input: AudioMeter | null = null
  #output: AudioMeter | null = null
  #player: HTMLAudioElement | null = null
  #frame = 0
  #connectionTimer: ReturnType<typeof setTimeout> | undefined
  #closeTimer: ReturnType<typeof setTimeout> | undefined
  #disconnectTimer: ReturnType<typeof setTimeout> | undefined

  getSnapshot = () => this.#snapshot

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(snapshot: CallSnapshot) {
    if (snapshot.status === this.#snapshot.status && snapshot.error === this.#snapshot.error
      && snapshot.inputBands === this.#snapshot.inputBands && snapshot.outputLevel === this.#snapshot.outputLevel) return
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #cleanup() {
    ++this.#generation
    this.#abort?.abort()
    this.#abort = null
    clearTimeout(this.#connectionTimer)
    clearTimeout(this.#closeTimer)
    clearTimeout(this.#disconnectTimer)
    cancelAnimationFrame(this.#frame)
    if (this.#player) {
      this.#player.onerror = null
      this.#player.onpause = null
      this.#player.onended = null
      this.#player.pause()
      this.#player.srcObject = null
    }
    this.#player = null
    this.#input?.disconnect()
    this.#output?.disconnect()
    this.#input = null
    this.#output = null
    for (const track of this.#microphone?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    this.#microphone = null
    if (this.#events) {
      this.#events.onmessage = null
      this.#events.onclose = null
      this.#events.onerror = null
      this.#events.close()
    }
    this.#events = null
    if (this.#peer) {
      this.#peer.ontrack = null
      this.#peer.onconnectionstatechange = null
      this.#peer.getReceivers().forEach(({ track }) => track?.stop())
      this.#peer.close()
    }
    this.#peer = null
    if (this.#context) {
      this.#context.onstatechange = null
      if (this.#context.state !== 'closed') void this.#context.close().catch(() => {})
    }
    this.#context = null
  }

  #fail(message: string) {
    this.#cleanup()
    this.#publish({ ...IDLE, status: 'error', error: message })
  }

  #handleEvent(data: string) {
    let event
    try { event = JSON.parse(data) } catch { return }
    if (!event || typeof event !== 'object') return

    if (event.type === 'session.started' && this.#snapshot.status === 'connecting') {
      clearTimeout(this.#connectionTimer)
      this.#publish({ ...IDLE, status: 'connected' })
    } else if (event.type === 'session.closed') {
      this.#cleanup()
      this.#publish(event.reason === 'connection_lost'
        ? { ...IDLE, status: 'error', error: 'Connection lost. Please start a new call.' }
        : IDLE)
    } else if (event.type === 'error'
      || event.type === 'response.event' && event.event?.type === 'response.failed') {
      this.#fail('The conversation could not continue. Please start a new call.')
    }
  }

  #sampleAudio = (time: number, previous = 0) => {
    if (this.#snapshot.status !== 'connecting' && this.#snapshot.status !== 'connected') return
    if (time - previous >= 1000 / 30) {
      const input = this.#input?.read(true, time)
      const output = this.#player && !this.#player.paused ? this.#output?.read() : null
      this.#publish({
        ...this.#snapshot,
        inputBands: input?.bands ?? SILENT_BANDS,
        outputLevel: output?.level ?? 0,
      })
      previous = time
    }
    this.#frame = requestAnimationFrame((next) => this.#sampleAudio(next, previous))
  }

  start = async () => {
    if (['connecting', 'connected', 'closing'].includes(this.#snapshot.status)) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia
      || !window.AudioContext || !window.RTCPeerConnection) {
      this.#fail('Use a supported browser on HTTPS or localhost to start a call.')
      return
    }

    const generation = ++this.#generation
    const abort = new AbortController()
    this.#abort = abort
    this.#publish({ ...IDLE, status: 'connecting' })
    this.#connectionTimer = setTimeout(() => {
      this.#fail('The call took too long to connect. Please try again.')
    }, 30_000)

    try {
      // Resume synchronously inside the button gesture, before any permission await.
      const context = new window.AudioContext()
      this.#context = context
      const resumed = context.resume()
      void resumed.catch(() => {})
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (generation !== this.#generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.#microphone = stream
      for (const track of stream.getTracks()) {
        track.onended = () => this.#fail('Microphone disconnected. Reconnect it and start a new call.')
      }
      await resumed
      if (generation !== this.#generation) return
      if (context.state !== 'running') throw new Error('Allow audio playback in your browser, then try again.')

      this.#input = new AudioMeter(context, stream)
      const player = new window.Audio()
      player.autoplay = true
      player.setAttribute('playsinline', '')
      this.#player = player
      const playbackFailed = () => {
        if (generation !== this.#generation || this.#snapshot.status === 'closing' || !player.srcObject) return
        this.#fail('Audio playback is unavailable. Please start a new call.')
      }
      // play() only reports startup failures. A later media error or pause
      // must not leave a silent call connected and still sending microphone audio.
      player.onerror = playbackFailed
      player.onended = playbackFailed
      player.onpause = () => { if (player.paused) playbackFailed() }
      const peer = new window.RTCPeerConnection()
      this.#peer = peer
      peer.ontrack = ({ track, streams }) => {
        if (generation !== this.#generation || track.kind !== 'audio' || this.#snapshot.status === 'closing') return
        try {
          this.#output?.disconnect()
          const remoteStream = streams[0] ?? new MediaStream([track])
          this.#output = new AudioMeter(context, remoteStream)
          // Let the browser's media player own WebRTC playback. The analyser
          // only observes that stream and never creates a second audio output.
          player.srcObject = remoteStream
          void player.play().catch((error: unknown) => {
            if (generation !== this.#generation || this.#snapshot.status === 'closing'
              || player.srcObject !== remoteStream) return
            this.#fail(error instanceof DOMException && error.name === 'NotAllowedError'
              ? 'Allow audio playback in your browser, then start a new call.'
              : 'Audio playback is unavailable. Please start a new call.')
          })
        } catch {
          this.#fail('Audio playback is unavailable. Please start a new call.')
        }
      }
      peer.onconnectionstatechange = () => {
        clearTimeout(this.#disconnectTimer)
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          this.#fail('Connection lost. Please start a new call.')
        } else if (peer.connectionState === 'disconnected') {
          this.#disconnectTimer = setTimeout(() => this.#fail('Connection lost. Please start a new call.'), 5_000)
        }
      }
      context.onstatechange = () => {
        if (this.#snapshot.status === 'connected' && context.state !== 'running') {
          this.#fail('Audio was interrupted. Please start a new call.')
        }
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)
      const events = peer.createDataChannel('oai-events')
      this.#events = events
      events.onmessage = ({ data }) => this.#handleEvent(data)
      events.onclose = () => this.#fail('The call disconnected. Please start a new call.')
      events.onerror = () => this.#fail('Connection lost. Please start a new call.')

      this.#frame = requestAnimationFrame(this.#sampleAudio)
      await peer.setLocalDescription(await peer.createOffer())
      await waitForIce(peer, abort.signal)
      if (generation !== this.#generation) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('Could not connect. Please try again.')

      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
        signal: abort.signal,
      })
      const result = await response.json()
      if (generation !== this.#generation) return
      if (!response.ok) {
        throw new Error(typeof result.error === 'string' ? result.error : 'Could not start the call. Please try again.')
      }
      if (typeof result.session?.id !== 'string' || typeof result.transport?.sdp !== 'string') {
        throw new Error('Could not establish the call. Please try again.')
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp })
      // The HTTP request starts GPT-Live. Never send session.start here.
    } catch (error) {
      if (generation === this.#generation) this.#fail(startError(error))
    }
  }

  end = () => {
    if (this.#snapshot.status === 'closing') return
    if (this.#snapshot.status === 'connected' && this.#events?.readyState === 'open') {
      this.#publish({ ...IDLE, status: 'closing' })
      // Silence both sides immediately, retaining the transport until acknowledgment.
      this.#microphone?.getAudioTracks().forEach((track) => { track.enabled = false })
      this.#player?.pause()
      this.#output?.disconnect()
      this.#output = null
      cancelAnimationFrame(this.#frame)
      this.#closeTimer = setTimeout(() => {
        this.#fail('The call ended before shutdown was confirmed.')
      }, 15_000)
      try { this.#events.send(JSON.stringify({ type: 'session.close' })) }
      catch { this.#fail('Connection lost while ending the call.') }
    } else {
      this.dispose()
    }
  }

  dispose = () => {
    if (this.#snapshot.status === 'connected' && this.#events?.readyState === 'open') {
      try { this.#events.send(JSON.stringify({ type: 'session.close' })) } catch { /* Transport already closed. */ }
    }
    this.#cleanup()
    this.#publish(IDLE)
  }

  toggle = () => {
    if (this.#snapshot.status === 'connecting' || this.#snapshot.status === 'connected') this.end()
    else if (this.#snapshot.status !== 'closing') void this.start()
  }
}
