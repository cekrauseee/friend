export type MicrophoneStatus = 'idle' | 'requesting' | 'listening' | 'error'

export interface MicrophoneSnapshot {
  status: MicrophoneStatus
  level: number
  error: string | null
}

const IDLE: MicrophoneSnapshot = { status: 'idle', level: 0, error: null }

/** Normalize speech energy, discarding quiet background noise. */
export function measureVoiceLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  const rms = Math.sqrt(sum / samples.length)
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.008)) * 2.5)
}

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Allow microphone access in your browser, then try again.'
    case 'NotFoundError':
      return 'Connect a microphone, then try again.'
    case 'NotReadableError':
      return 'Your microphone is unavailable. Check other apps, then try again.'
    default:
      return 'Could not start your microphone. Please try again.'
  }
}

/** Owns the live audio resources; no audio is recorded, played back, or sent. */
export class Microphone {
  #snapshot = IDLE
  #listeners = new Set<() => void>()
  #context: AudioContext | null = null
  #stream: MediaStream | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #analyser: AnalyserNode | null = null
  #frame = 0
  #request = 0

  getSnapshot = () => this.#snapshot

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(snapshot: MicrophoneSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #release() {
    cancelAnimationFrame(this.#frame)
    this.#frame = 0
    for (const track of this.#stream?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    this.#stream = null
    this.#source?.disconnect()
    this.#source = null
    this.#analyser?.disconnect()
    this.#analyser = null
    if (this.#context && this.#context.state !== 'closed') {
      void this.#context.close().catch(() => {})
    }
    this.#context = null
  }

  stop = () => {
    // A late permission response must never reopen a canceled microphone.
    this.#request += 1
    this.#release()
    this.#publish(IDLE)
  }

  start = async () => {
    if (this.#snapshot.status === 'requesting' || this.#snapshot.status === 'listening') return

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.#publish({
        status: 'error', level: 0,
        error: 'Microphone access requires HTTPS or localhost and a supported browser.',
      })
      return
    }

    if (!window.AudioContext) {
      this.#publish({
        status: 'error', level: 0,
        error: 'Your browser does not support microphone visualization.',
      })
      return
    }

    const request = ++this.#request
    this.#publish({ status: 'requesting', level: 0, error: null })

    try {
      // Resume within the click gesture, including on mobile browsers.
      const context = new window.AudioContext()
      this.#context = context
      const resumed = context.resume()
      // Permission may stay pending longer than the resume promise.
      void resumed.catch(() => {})
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })

      if (request !== this.#request) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.#stream = stream
      for (const track of stream.getTracks()) {
        track.onended = () => {
          this.stop()
          this.#publish({
            status: 'error', level: 0,
            error: 'Microphone disconnected. Reconnect it, then try again.',
          })
        }
      }

      await resumed
      if (request !== this.#request) return
      if (context.state !== 'running' || !stream.getAudioTracks().some((track) => track.readyState === 'live')) {
        throw new DOMException('Microphone is not active', 'NotReadableError')
      }

      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      const source = context.createMediaStreamSource(stream)
      this.#analyser = analyser
      this.#source = source
      // No destination connection: the microphone cannot feed back into speakers.
      source.connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let previousFrame = 0
      this.#publish({ status: 'listening', level: 0, error: null })

      const sampleAudio = (time: number) => {
        if (request !== this.#request) return
        if (time - previousFrame >= 1000 / 30) {
          previousFrame = time
          analyser.getFloatTimeDomainData(samples)
          const level = measureVoiceLevel(samples)
          if (Math.abs(level - this.#snapshot.level) > 0.002 || (level === 0 && this.#snapshot.level !== 0)) {
            this.#publish({ status: 'listening', level, error: null })
          }
        }
        this.#frame = requestAnimationFrame(sampleAudio)
      }
      this.#frame = requestAnimationFrame(sampleAudio)
    } catch (error) {
      if (request !== this.#request) return
      this.#release()
      this.#publish({ status: 'error', level: 0, error: microphoneError(error) })
    }
  }

  toggle = () => {
    if (this.#snapshot.status === 'listening' || this.#snapshot.status === 'requesting') {
      this.stop()
    } else {
      void this.start()
    }
  }
}
