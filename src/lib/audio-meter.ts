const BAND_COUNT = 32

export const SILENT_BANDS: number[] = Array(BAND_COUNT).fill(0)

function normalizeLevel(samples: Float32Array) {
  let energy = 0
  for (const sample of samples) energy += sample * sample
  const rms = Math.sqrt(energy / samples.length)
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.008)) * 2.5)
}

/** Reads a stream without opening another microphone or retaining audio history. */
export class AudioMeter {
  #source: MediaStreamAudioSourceNode
  #analyser: AnalyserNode
  #samples: Float32Array<ArrayBuffer>
  #frequencies: Uint8Array<ArrayBuffer>

  constructor(context: AudioContext, stream: MediaStream, playback = false) {
    this.#analyser = context.createAnalyser()
    this.#analyser.fftSize = 1024
    this.#analyser.smoothingTimeConstant = 0.7
    this.#samples = new Float32Array(this.#analyser.fftSize)
    this.#frequencies = new Uint8Array(this.#analyser.frequencyBinCount)
    this.#source = context.createMediaStreamSource(stream)
    this.#source.connect(this.#analyser)
    if (playback) this.#analyser.connect(context.destination)
  }

  read(includeBands = false) {
    this.#analyser.getFloatTimeDomainData(this.#samples)
    const level = normalizeLevel(this.#samples)
    if (!includeBands || level === 0) return { level, bands: SILENT_BANDS }

    this.#analyser.getByteFrequencyData(this.#frequencies)
    // Low frequencies at the center, higher frequencies toward the edges.
    // Every bar keeps its position; there is no scrolling history.
    const bands = Array.from({ length: BAND_COUNT }, (_, index) => {
      const distance = Math.abs(index - (BAND_COUNT - 1) / 2)
      const bin = Math.min(this.#frequencies.length - 1, 1 + Math.floor(distance * 3))
      return Math.min(1, (this.#frequencies[bin] / 255) ** 1.5)
    })
    return { level, bands }
  }

  disconnect() {
    this.#source.disconnect()
    this.#analyser.disconnect()
  }
}
