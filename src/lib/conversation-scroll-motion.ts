// Automatic primitive commands are ignored. Send alignment and reader jumps
// enter through an explicit command, with one shared scroll animation.
export function attachConversationScrollMotion(node: HTMLDivElement) {
  const originalScrollTo = node.scrollTo
  const nativeScrollTo = originalScrollTo.bind(node)
  let frame: number | null = null
  let motion: { start: number; target: () => number; started: number; duration: number; done?: () => void } | null = null

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    motion = null
  }
  const bounded = (top: number) => Math.min(Math.max(0, top), Math.max(0, node.scrollHeight - node.clientHeight))
  const tick = (now: number) => {
    if (!motion) return
    const progress = Math.min(1, (now - motion.started) / motion.duration)
    const smoothProgress = progress * progress * (3 - 2 * progress)
    const easedProgress = progress * 0.25 + smoothProgress * 0.75
    node.scrollTop = bounded(motion.start + (motion.target() - motion.start) * easedProgress)
    if (progress < 1) frame = requestAnimationFrame(tick)
    else {
      const done = motion.done
      frame = null
      motion = null
      done?.()
    }
  }
  const animateTo = (target: () => number, done?: () => void) => {
    cancel()
    const end = bounded(target())
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(end - node.scrollTop) <= 0.75) {
      nativeScrollTo({ top: end, behavior: 'auto' })
      done?.()
      return
    }
    motion = {
      start: node.scrollTop, target, done, started: performance.now(),
      duration: Math.min(420, Math.max(180, Math.abs(end - node.scrollTop) / 2)),
    }
    frame = requestAnimationFrame(tick)
  }
  const scrollTo: HTMLDivElement['scrollTo'] = (options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === 'number') { cancel(); nativeScrollTo(options, y ?? 0); return }
    if (options?.top === undefined) { nativeScrollTo(options); return }
    if (options.behavior === 'smooth') animateTo(() => options.top!)
  }
  node.scrollTo = scrollTo

  return {
    animateTo, cancel,
    get animating() { return motion !== null },
    dispose() { cancel(); if (node.scrollTo === scrollTo) node.scrollTo = originalScrollTo },
  }
}
