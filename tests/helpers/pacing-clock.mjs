export function createPacingClock() {
  let now = 0
  let sequence = 0
  const jobs = new Map()
  const schedule = (callback, delay) => {
    const id = ++sequence
    jobs.set(id, { callback, at: now + delay })
    return () => jobs.delete(id)
  }
  const advance = (elapsed = 80) => {
    const end = now + elapsed
    while (true) {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      now = Math.max(now, next[1].at)
      jobs.delete(next[0])
      next[1].callback()
    }
    now = end
  }
  return {
    schedule, advance,
    now: () => now,
    stall: (elapsed) => { now += elapsed },
    get pending() { return jobs.size },
    flush() {
      let steps = 0
      while (jobs.size) {
        if (++steps > 10000) throw new Error('Pacing did not drain')
        advance()
      }
    },
  }
}
