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
  #bands = SILENT_BANDS
  #lastRead: number | null = null

  constructor(context: AudioContext, stream: MediaStream) {
    this.#analyser = context.createAnalyser()
    this.#analyser.fftSize = 1024
    this.#analyser.smoothingTimeConstant = 0.7
    this.#samples = new Float32Array(this.#analyser.fftSize)
    this.#frequencies = new Uint8Array(this.#analyser.frequencyBinCount)
    this.#source = context.createMediaStreamSource(stream)
    this.#source.connect(this.#analyser)
  }

  read(includeBands = false, time = performance.now()) {
    this.#analyser.getFloatTimeDomainData(this.#samples)
    const level = normalizeLevel(this.#samples)
    if (!includeBands) return { level, bands: SILENT_BANDS }

    this.#analyser.getByteFrequencyData(this.#frequencies)
    const elapsed = this.#lastRead === null ? 1 / 30 : Math.max(0, (time - this.#lastRead) / 1000)
    this.#lastRead = time
    // Low frequencies at the center, higher frequencies toward the edges.
    // Every bar keeps its position; there is no scrolling history.
    const bands = Array.from({ length: BAND_COUNT }, (_, index) => {
      const distance = Math.abs(index - (BAND_COUNT - 1) / 2)
      const bin = Math.min(this.#frequencies.length - 1, 1 + Math.floor(distance * 3))
      const target = level === 0 ? 0 : Math.min(1, (this.#frequencies[bin] / 255) ** 1.5)
      const current = this.#bands[index]
      // Follow speech quickly, then settle over a few hundred milliseconds.
      // Silence changes the target; it must not instantly erase every bar.
      const duration = target > current ? 0.035 : 0.22
      const value = target + (current - target) * Math.exp(-elapsed / duration)
      return value < 0.002 ? 0 : value
    })
    this.#bands = bands.every((value) => value === 0) ? SILENT_BANDS : bands
    return { level, bands: this.#bands }
  }

  disconnect() {
    this.#source.disconnect()
    this.#analyser.disconnect()
  }
}
