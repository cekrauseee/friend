import { AudioMeter, SILENT_BANDS } from './audio-meter.ts'
import { transcribeAudio, TranscriptionError } from './transcription-client.ts'
import type { TranscriptionTransport } from './transcription-client.ts'

export type CaptureStatus = 'idle' | 'starting' | 'recording' | 'processing' | 'error'
export type CaptureIntent = 'insert' | 'send'
export interface CaptureResult { text: string; intent: CaptureIntent }
export interface CaptureSnapshot {
  status: CaptureStatus
  error: string | null
  inputBands: number[]
}

const IDLE: CaptureSnapshot = { status: 'idle', error: null, inputBands: SILENT_BANDS }
const MAX_BYTES = 25_000_000
const MAX_DURATION_MS = 5 * 60 * 1000
const FORMATS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'video/mp4']

function startupError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Allow microphone access in your browser, then try again.'
    }
    if (error.name === 'NotFoundError') return 'Connect a microphone, then try again.'
    if (error.name === 'NotReadableError') return 'Your microphone is unavailable. Check other apps, then try again.'
  }
  return 'Could not start recording. Check your microphone and try again.'
}

/** Owns local audio and its analyser. Only finalize may upload; cancel invalidates every async result. */
export class AudioCapture {
  #snapshot = IDLE
  #listeners = new Set<() => void>()
  #generation = 0
  #transport: TranscriptionTransport
  #stream: MediaStream | null = null
  #context: AudioContext | null = null
  #meter: AudioMeter | null = null
  #recorder: MediaRecorder | null = null
  #chunks: Blob[] = []
  #bytes = 0
  #frame = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #abort: AbortController | null = null
  #resolveStop: ((audio: Blob | null) => void) | null = null

  constructor(transport: TranscriptionTransport = transcribeAudio) {
    this.#transport = transport
  }

  getSnapshot = () => this.#snapshot
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(snapshot: CaptureSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #releaseMicrophone() {
    cancelAnimationFrame(this.#frame)
    this.#frame = 0
    this.#meter?.disconnect()
    this.#meter = null
    for (const track of this.#stream?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    this.#stream = null
    if (this.#context && this.#context.state !== 'closed') void this.#context.close().catch(() => {})
    this.#context = null
  }

  #cleanup() {
    ++this.#generation
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#abort?.abort()
    this.#abort = null
    if (this.#recorder) {
      this.#recorder.ondataavailable = null
      this.#recorder.onstop = null
      this.#recorder.onerror = null
      if (this.#recorder.state !== 'inactive') this.#recorder.stop()
    }
    this.#recorder = null
    this.#releaseMicrophone()
    this.#chunks = []
    this.#bytes = 0
    this.#resolveStop?.(null)
    this.#resolveStop = null
  }

  #fail(message: string) {
    this.#cleanup()
    this.#publish({ ...IDLE, status: 'error', error: message })
  }

  #sample = (time: number, previous = 0) => {
    if (this.#snapshot.status !== 'recording') return
    if (time - previous >= 1000 / 30) {
      const sample = this.#meter?.read(true, time)
      if (sample) this.#publish({ ...this.#snapshot, inputBands: sample.bands })
      previous = time
    }
    this.#frame = requestAnimationFrame((next) => this.#sample(next, previous))
  }

  start = async (): Promise<void> => {
    if (this.#snapshot.status !== 'idle' && this.#snapshot.status !== 'error') return
    this.#cleanup()
    const generation = this.#generation
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' ||
      typeof AudioContext === 'undefined') {
      this.#fail('Recording is unavailable in this browser. Use a browser with microphone recording support.')
      return
    }
    const mimeType = FORMATS.find((format) => MediaRecorder.isTypeSupported(format))
    if (!mimeType) {
      this.#fail('This browser cannot record WebM or MP4 audio. Try another browser.')
      return
    }
    this.#publish({ ...IDLE, status: 'starting' })
    this.#timer = setTimeout(() => this.#fail('Microphone access took too long. Allow access and try again.'), 30_000)
    try {
      // Create/resume during the initiating gesture, before waiting for permission.
      const context = new AudioContext()
      this.#context = context
      const resumed = context.resume().catch(() => {
        if (generation === this.#generation) this.#fail('Could not activate audio recording. Try again.')
      })
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (generation !== this.#generation) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      this.#stream = stream
      await resumed
      if (generation !== this.#generation) return
      this.#meter = new AudioMeter(context, stream)
      const recorder = new MediaRecorder(stream, { mimeType })
      this.#recorder = recorder
      recorder.ondataavailable = ({ data }) => {
        if (generation !== this.#generation || !data.size) return
        this.#bytes += data.size
        if (this.#bytes > MAX_BYTES) {
          this.#fail('The recording exceeds the 25 MB limit. Record a shorter message.')
          return
        }
        this.#chunks.push(data)
      }
      recorder.onerror = () => this.#fail('Recording failed. Check your microphone and try again.')
      recorder.onstop = () => {
        if (generation !== this.#generation) return
        if (this.#snapshot.status !== 'processing') {
          this.#fail('Recording stopped unexpectedly. Record a new message and try again.')
          return
        }
        const audio = new Blob(this.#chunks, { type: recorder.mimeType || mimeType })
        this.#chunks = []
        this.#bytes = 0
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
        this.#recorder = null
        this.#resolveStop?.(audio)
        this.#resolveStop = null
      }
      for (const track of stream.getTracks()) {
        track.onended = () => this.#fail('Microphone disconnected. Connect it and record a new message.')
      }
      recorder.start(1000)
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => this.#fail('Recording reached the 5-minute limit. Record a shorter message.'), MAX_DURATION_MS)
      this.#publish({ ...IDLE, status: 'recording' })
      this.#frame = requestAnimationFrame((time) => this.#sample(time))
    } catch (error) {
      if (generation === this.#generation) this.#fail(startupError(error))
    }
  }

  finalize = async (intent: CaptureIntent): Promise<CaptureResult | null> => {
    if (this.#snapshot.status !== 'recording' || !this.#recorder) return null
    const generation = this.#generation
    const recorder = this.#recorder
    this.#publish({ ...IDLE, status: 'processing' })
    clearTimeout(this.#timer)
    // A broken recorder or transport cannot leave the composer processing forever.
    this.#timer = setTimeout(() => this.#fail('Transcription took too long. Record a new message and try again.'), 130_000)
    try {
      const completed = new Promise<Blob | null>((resolve) => { this.#resolveStop = resolve })
      recorder.stop()
      this.#releaseMicrophone()
      const audio = await completed
      if (generation !== this.#generation || !audio) return null
      if (!audio.size) {
        this.#fail('No audio was recorded. Record a new message and try again.')
        return null
      }
      const abort = new AbortController()
      this.#abort = abort
      const text = (await this.#transport(audio, abort.signal)).trim()
      if (generation !== this.#generation) return null
      if (!text) throw new TranscriptionError('No speech was detected. Record a new message and try again.', 'empty_transcript')
      this.#cleanup()
      this.#publish(IDLE)
      return { text, intent }
    } catch (error) {
      if (generation === this.#generation) {
        this.#fail(error instanceof TranscriptionError ? error.message : 'Could not transcribe the recording. Please try again.')
      }
      return null
    }
  }

  cancel = () => { this.#cleanup(); this.#publish(IDLE) }
  dispose = this.cancel
}
