export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function streamRandom() {
  return seededRandom(crypto.getRandomValues(new Uint32Array(1))[0])
}

export function createVisualRhythm(random: () => number = streamRandom()) {
  let base: number = visualRhythm.baselineMs
  let target: number = visualRhythm.baselineMs
  let changeAt = -Infinity
  let nextAt: number | null = null
  let requestedAt = -Infinity
  const interval = (time: number) => {
    if (time >= changeAt) {
      target = 45 + random() * 20
      changeAt = time + 300 + random() * 300
    }
    base += (target - base) * 0.25
    return Math.max(visualRhythm.minimumMs, Math.min(visualRhythm.maximumMs, base + (random() - 0.5) * 12))
  }
  return {
    next(time: number) {
      // Preserve phase across short gaps without scheduling empty ticks.
      if (nextAt === null || time - requestedAt > visualRhythm.restartGapMs) nextAt = time + interval(time)
      else while (nextAt <= time) nextAt += interval(nextAt)
      requestedAt = time
      return nextAt
    },
    markVisible(time: number) { requestedAt = time },
  }
}
export const visualRhythm = { baselineMs: 55, minimumMs: 40, maximumMs: 75, restartGapMs: 500 } as const
