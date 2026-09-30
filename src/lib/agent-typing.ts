import { streamRandom } from './stream-rhythm.ts'

export const agentTypingRhythm = {
  minimumMs: 70,
  eligibleMinMs: 75,
  eligibleMaxMs: 115,
  omission: 0.05,
  minVolume: 0.075,
  maxVolume: 0.10,
  minRate: 0.97,
  maxRate: 1.03,
  recoveryGain: 0.8,
} as const

// Selection only: each decision requires newly displayed content. No timers.
export function createAgentTyping(
  now: () => number = () => performance.now(),
  random: () => number = streamRandom(),
) {
  let lastPlayed = -Infinity
  let eligibleAt = -Infinity
  let volume = 0.0875
  let playbackRate = 1
  return {
    select(text: string, recovering = false) {
      if (!text.trim()) return null
      const time = now()
      if (time - lastPlayed < agentTypingRhythm.minimumMs || time < eligibleAt) return null
      eligibleAt = time + agentTypingRhythm.eligibleMinMs
        + random() * (agentTypingRhythm.eligibleMaxMs - agentTypingRhythm.eligibleMinMs)
      if (random() < agentTypingRhythm.omission) return null
      volume += (agentTypingRhythm.minVolume + random() * (agentTypingRhythm.maxVolume - agentTypingRhythm.minVolume) - volume) * 0.35
      playbackRate += (agentTypingRhythm.minRate + random() * (agentTypingRhythm.maxRate - agentTypingRhythm.minRate) - playbackRate) * 0.5
      lastPlayed = time
      return {
        volume: volume * (recovering ? agentTypingRhythm.recoveryGain : 1),
        playbackRate,
        cooldownMs: agentTypingRhythm.minimumMs,
        retrigger: 'restart' as const,
      }
    },
  }
}
