import { consumeReplyGrowth, jumpTarget } from './conversation-geometry.ts'
import type { attachConversationScrollMotion } from './conversation-scroll-motion.ts'

type ScrollMotion = ReturnType<typeof attachConversationScrollMotion>

function contentTop(element: HTMLElement, scroll: HTMLElement) {
  return element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop
}

export function attachConversationSpacer(scroll: HTMLDivElement, motion: ScrollMotion) {
  const content = scroll.querySelector<HTMLElement>('[data-conversation-content]')!
  const spacerNode = content.querySelector<HTMLElement>('[data-message-scroller-spacer]')!
  let spacer = parseFloat(spacerNode.style.height) || 0
  let pendingId: string | null = null
  let latestId: string | null = null
  let resetGrowth = false
  let maxTurnHeight = 0
  let previousTop = scroll.scrollTop
  let userIntentUntil = 0
  let pointerActive = false
  let frame: number | null = null
  let observedTurn: HTMLElement | null = null

  const turns = () => [...content.querySelectorAll<HTMLElement>('[data-turn-id]')]
  const realEnd = () => {
    const last = turns().at(-1)
    return last ? contentTop(last, scroll) + last.offsetHeight + parseFloat(getComputedStyle(content).paddingBottom) : 0
  }
  const writeSpacer = (height: number) => {
    const next = Math.max(0, height)
    if (Math.abs(next - spacer) < 0.01) return
    spacer = next
    const gap = parseFloat(getComputedStyle(content).rowGap) || 0
    spacerNode.hidden = next === 0
    spacerNode.style.height = `${next}px`
    // Cancel the transcript gap so only the spacer's own height is added.
    spacerNode.style.marginTop = next ? `${-gap}px` : ''
  }
  const consumeHiddenSpace = () => {
    writeSpacer(Math.min(spacer, Math.max(0, scroll.scrollTop + scroll.clientHeight - realEnd())))
  }
  const measure = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    const latest = turns().at(-1)
    const height = latest?.offsetHeight ?? 0
    if (latest?.dataset.turnId !== latestId || resetGrowth) {
      latestId = latest?.dataset.turnId ?? null
      maxTurnHeight = height
      resetGrowth = false
    } else {
      const growth = consumeReplyGrowth(spacer, maxTurnHeight, height)
      maxTurnHeight = growth.maxHeightSeen
      writeSpacer(growth.spacerPx)
    }
    if (latest !== observedTurn) {
      if (observedTurn) sizes.unobserve(observedTurn)
      observedTurn = latest ?? null
      if (observedTurn) sizes.observe(observedTurn)
    }
    if (pendingId) {
      const turn = turns().find((node) => node.dataset.turnId === pendingId)
      if (!turn || scroll.clientHeight <= 0) return
      pendingId = null
      let allocate = true
      let previousHeight = scroll.clientHeight
      motion.animateTo(() => {
        const inset = parseFloat(getComputedStyle(scroll).scrollPaddingTop) || 12
        const target = Math.max(0, contentTop(turn, scroll) - inset)
        // Use the real transcript end, not scrollHeight's min-height filler.
        const needed = Math.max(0, target + scroll.clientHeight - realEnd())
        if (allocate) { writeSpacer(needed); allocate = false }
        else if (scroll.clientHeight > previousHeight) writeSpacer(spacer + scroll.clientHeight - previousHeight)
        previousHeight = scroll.clientHeight
        return target
      }, () => { previousTop = scroll.scrollTop })
    }
  }
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure) }
  const sizes = new ResizeObserver(schedule)
  sizes.observe(scroll)
  sizes.observe(content)
  const mutations = new MutationObserver(schedule)
  mutations.observe(content, { childList: true, characterData: true, subtree: true })

  const scrollIntent = () => {
    userIntentUntil = performance.now() + 500
    pendingId = null
    motion.cancel()
  }
  const onPointerDown = () => { pointerActive = true; scrollIntent() }
  const onPointerUp = () => { pointerActive = false }
  const onScroll = () => {
    const top = scroll.scrollTop
    if (!motion.animating && top < previousTop && (pointerActive || performance.now() <= userIntentUntil)) {
      consumeHiddenSpace()
      userIntentUntil = performance.now() + 500
    }
    previousTop = scroll.scrollTop
  }
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scroll.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  measure()

  return {
    measure, scrollIntent,
    acceptTurn(id: string) { motion.cancel(); pendingId = id; schedule() },
    retryTurn() { motion.cancel(); pendingId = null; resetGrowth = true; schedule() },
    jumpToLatest() {
      pendingId = null
      motion.animateTo(() => jumpTarget(realEnd(), scroll.clientHeight, scroll.scrollHeight), () => {
        consumeHiddenSpace()
        previousTop = scroll.scrollTop
      })
    },
    dispose() {
      sizes.disconnect(); mutations.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    },
  }
}
