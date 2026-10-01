import { createVisualRhythm, streamRandom, visualRhythm } from './stream-rhythm.ts'

export const responsePacing = {
  baseCharacters: 12,
  targetLagMs: 200,
  maxAgeMs: 350,
  finishMs: 250,
  pauseBacklog: 80,
  sentencePauseMs: 35,
  paragraphPauseMs: 55,
} as const

export type PacingScheduler = (callback: () => void, delay: number) => () => void
export const schedulePacing: PacingScheduler = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function safeCut(text: string, target: number) {
  for (const segment of graphemes.segment(text)) {
    const end = segment.index + segment.segment.length
    if (end >= target) return end
  }
  return text.length
}

function nextChunk(text: string, budget: number, minimum: number, inCode: boolean) {
  if (budget >= text.length) return text
  let cut = safeCut(text, budget)
  if (inCode) {
    const lineEnd = text.lastIndexOf('\n', cut - 1) + 1
    if (lineEnd >= Math.max(minimum, budget * 0.7)) cut = lineEnd
  } else {
    const lookahead = text.slice(0, cut + 24)
    let closest: number | null = null
    for (const segment of words.segment(lookahead)) {
      const end = segment.index + segment.segment.length
      if (end === lookahead.length && lookahead.length < text.length) continue
      if (end >= minimum && end >= budget * 0.7 && end <= budget * 1.3
        && (closest === null || Math.abs(end - budget) < Math.abs(closest - budget))) closest = end
    }
    cut = safeCut(text, closest ?? cut)
  }
  return text.slice(0, cut)
}

export function createPacedText(
  onChunk: (text: string, accelerated: boolean) => void,
  onDrained: () => void,
  schedule: PacingScheduler = schedulePacing,
  now: () => number = () => performance.now(),
  random: () => number = streamRandom(),
) {
  let pending = ''
  let consumed = 0
  let received = 0
  const arrivals: { end: number; at: number }[] = []
  let arrivalHead = 0
  const rhythm = createVisualRhythm(random)
  let scheduledDelay = 55
  let finishDeadline: number | null = null
  let stopped = false
  let cancelTimer: (() => void) | null = null
  let currentLine = ''
  let fence: { marker: string; width: number } | null = null
  let tail = ''
  let pauseUntil = -Infinity
  let pausedBoundary = -1

  const observeText = (chunk: string) => {
    const lines = (currentLine + chunk).split('\n')
    currentLine = lines.pop() ?? ''
    for (const line of lines) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!marker) continue
      if (!fence) fence = { marker: marker[1][0], width: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.width && !marker[2].trim()) fence = null
    }
    tail = (tail + chunk).slice(-80)
    const whitespace = tail.match(/\s*$/)?.[0].length ?? 0
    const boundary = consumed - whitespace
    const paragraph = /\n\s*\n$/.test(tail)
    const sentence = /[.!?。！？]["'”’)\]]*\s*$/u.test(tail)
    if (!fence && (paragraph || sentence) && boundary > pausedBoundary) {
      pausedBoundary = boundary
      if (finishDeadline === null && pending.length <= responsePacing.pauseBacklog) {
        // Extend one beat; silence since this boundary also satisfies the pause.
        pauseUntil = now() + visualRhythm.baselineMs + (paragraph ? responsePacing.paragraphPauseMs : responsePacing.sentencePauseMs)
      }
    }
  }
  const drained = () => { stopped = true; cancelTimer?.(); cancelTimer = null; onDrained() }
  const tick = () => {
    cancelTimer = null
    if (stopped) return
    const time = now()
    let overdue = 0
    for (let index = arrivalHead; index < arrivals.length && time - arrivals[index].at >= responsePacing.maxAgeMs; index++) {
      overdue = Math.max(overdue, arrivals[index].end - consumed)
    }
    if (pending) {
      const horizon = finishDeadline === null ? responsePacing.targetLagMs : Math.max(0, finishDeadline - time)
      const budget = horizon === 0 ? pending.length : Math.max(
        responsePacing.baseCharacters, overdue, Math.ceil(pending.length * scheduledDelay / horizon),
      )
      const chunk = nextChunk(pending, budget, overdue, Boolean(fence))
      pending = pending.slice(chunk.length)
      consumed += chunk.length
      while (arrivalHead < arrivals.length && arrivals[arrivalHead].end <= consumed) arrivalHead++
      if (arrivalHead === arrivals.length) { arrivals.length = 0; arrivalHead = 0 }
      else if (arrivalHead > 128) { arrivals.splice(0, arrivalHead); arrivalHead = 0 }
      observeText(chunk)
      rhythm.markVisible(time)
      onChunk(chunk, finishDeadline !== null || overdue > 0 || budget > responsePacing.baseCharacters * 2)
      // A subscriber may cancel the attempt while consuming this chunk.
      if (stopped) return
    }
    if (!pending) {
      if (finishDeadline !== null) drained()
    } else queue()
  }
  const queue = () => {
    if (stopped || cancelTimer !== null) return
    const time = now()
    let next = rhythm.next(time)
    if (finishDeadline === null && pending.length <= responsePacing.pauseBacklog && !fence) next = Math.max(next, pauseUntil)
    let delay = next - time
    if (arrivals[arrivalHead]) delay = Math.min(delay, Math.max(0, arrivals[arrivalHead].at + responsePacing.maxAgeMs - time))
    if (finishDeadline !== null) delay = Math.min(delay, Math.max(0, finishDeadline - time))
    scheduledDelay = delay
    cancelTimer = schedule(tick, delay)
  }

  return {
    push(text: string) {
      if (stopped || finishDeadline !== null || !text) return
      pending += text
      received += text.length
      const time = now()
      const last = arrivals.at(-1)
      if (last && last.at === time) last.end = received
      else arrivals.push({ end: received, at: time })
      queue()
    },
    finish() {
      if (stopped || finishDeadline !== null) return
      finishDeadline = now() + responsePacing.finishMs
      if (pending) { cancelTimer?.(); cancelTimer = null; queue() }
      else drained()
    },
    cancel() {
      stopped = true
      pending = ''
      arrivals.length = 0
      cancelTimer?.()
      cancelTimer = null
    },
  }
}
