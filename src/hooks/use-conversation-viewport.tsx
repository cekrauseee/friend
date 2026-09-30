import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationTurn } from '@/lib/text-conversation'
import {
  consumeReplyGrowth,
  consumeUpwardScroll,
  distanceToRealEnd,
  GEOMETRY_EPSILON,
  JUMP_DISTANCE_PX,
  jumpTarget,
  sendAlignment,
} from '@/lib/conversation-geometry'
import type { ConversationViewportBridge } from '@/components/text-conversation-view'
import { ArrowDown, Ellipsis } from 'lucide-react'
import './conversation-viewport.css'

type PendingAlignment = { id: string; first: boolean; frames: number; stableFrames: number; lastHeight: number }

function contentTop(element: HTMLElement, scroll: HTMLElement) {
  return element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop
}

export function useConversationViewport(turns: ConversationTurn[], activeTurnId: string | null, textMode: boolean) {
  const [spacerPx, setSpacerPx] = useState(0)
  const [showJump, setShowJump] = useState(false)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const scrollNode = useRef<HTMLDivElement | null>(null)
  const tailNode = useRef<HTMLDivElement | null>(null)
  const composerNode = useRef<HTMLDivElement | null>(null)
  const turnNodes = useRef(new Map<string, HTMLDivElement>())
  const replyNodes = useRef(new Map<string, HTMLDivElement>())
  const spacer = useRef(0)
  const renderedSpacer = useRef(0)
  const latestId = useRef<string | null>(null)
  const maxReplyHeight = useRef(0)
  const pendingRetry = useRef<string | null>(null)
  const pendingAlignment = useRef<PendingAlignment | null>(null)
  const frame = useRef<number | null>(null)
  const animation = useRef<number | null>(null)
  const lastScrollTop = useRef(0)
  const suppressScrollUntil = useRef(0)
  const userIntentUntil = useRef(0)
  const pointerActive = useRef(false)
  const touchActive = useRef(false)
  const reducedMotion = useRef(false)
  const turnsCurrent = useRef(turns)
  const measureRef = useRef<() => void>(() => {})

  const writeSpacer = useCallback((value: number) => {
    const next = Math.max(0, value)
    spacer.current = next
    if (Math.abs(next - renderedSpacer.current) < GEOMETRY_EPSILON) return
    renderedSpacer.current = next
    const spacerNode = scrollNode.current?.querySelector<HTMLElement>('[data-conversation-spacer]')
    if (spacerNode) spacerNode.style.blockSize = `${next}px`
    if (scrollNode.current) {
      suppressScrollUntil.current = performance.now() + 100
      lastScrollTop.current = scrollNode.current.scrollTop
    }
    setSpacerPx(next)
  }, [])

  const setProgrammaticScroll = useCallback((node: HTMLDivElement, top: number) => {
    suppressScrollUntil.current = performance.now() + 100
    node.scrollTop = Math.min(Math.max(0, top), Math.max(0, node.scrollHeight - node.clientHeight))
    lastScrollTop.current = node.scrollTop
  }, [])

  const cancelJump = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
  }, [])

  const measure = useCallback(() => {
    frame.current = null
    const scroll = scrollNode.current
    if (!scroll || !textMode) return
    const tail = tailNode.current
    const id = latestId.current
    const reply = id ? replyNodes.current.get(id) : null
    const replyHeight = reply?.getBoundingClientRect().height ?? 0
    const realEnd = tail ? contentTop(tail, scroll) : 0
    const scrollTop = scroll.scrollTop
    const clientHeight = scroll.clientHeight
    const scrollHeight = scroll.scrollHeight

    if (id && pendingRetry.current === id) {
      const turn = turnsCurrent.current.find((item) => item.id === id)
      if (turn?.status === 'waiting' && turn.assistantText === '') {
        maxReplyHeight.current = replyHeight
        pendingRetry.current = null
      }
    } else if (id && reply) {
      const result = consumeReplyGrowth(spacer.current, maxReplyHeight.current, replyHeight)
      maxReplyHeight.current = result.maxHeightSeen
      writeSpacer(result.spacerPx)
    }

    const pending = pendingAlignment.current
    if (pending) {
      const turn = turnNodes.current.get(pending.id)
      if (turn && clientHeight > 0) {
        pending.frames += 1
        pending.stableFrames = Math.abs(clientHeight - pending.lastHeight) < GEOMETRY_EPSILON
          ? pending.stableFrames + 1 : 0
        pending.lastHeight = clientHeight
        // The first send relocates the composer. Wait for the scrollport to settle.
        if ((pending.first ? pending.stableFrames >= 5 : pending.stableFrames >= 1) || pending.frames >= 45) {
          const alignment = sendAlignment({
            userTop: contentTop(turn, scroll),
            topInset: 12,
            scrollHeight,
            clientHeight,
            spacerPx: spacer.current,
          })
          writeSpacer(alignment.spacerPx)
          pendingAlignment.current = null
          requestAnimationFrame(() => {
            if (scrollNode.current !== scroll || !textMode) return
            setProgrammaticScroll(scroll, alignment.target)
            const end = tailNode.current ? contentTop(tailNode.current, scroll) : 0
            setShowJump(distanceToRealEnd(end, scroll.scrollTop, scroll.clientHeight) > JUMP_DISTANCE_PX)
          })
        }
      }
      if (pendingAlignment.current) {
        frame.current = requestAnimationFrame(() => measureRef.current())
      }
    }

    const distance = distanceToRealEnd(realEnd, scrollTop, clientHeight)
    setShowJump((previous) => previous === (distance > JUMP_DISTANCE_PX) ? previous : distance > JUMP_DISTANCE_PX)
  }, [setProgrammaticScroll, textMode, writeSpacer])

  const scheduleMeasure = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(measure)
  }, [measure])

  useLayoutEffect(() => {
    turnsCurrent.current = turns
    measureRef.current = measure
  }, [turns, measure])

  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollNode.current = node
    setScrollElement(node)
    if (node) {
      lastScrollTop.current = node.scrollTop
      scheduleMeasure()
    }
  }, [scheduleMeasure])
  const tailRef = useCallback((node: HTMLDivElement | null) => {
    tailNode.current = node
    scheduleMeasure()
  }, [scheduleMeasure])
  const composerRef = useCallback((node: HTMLDivElement | null) => {
    composerNode.current = node
    scheduleMeasure()
  }, [scheduleMeasure])
  const turnRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) turnNodes.current.set(id, node)
    else turnNodes.current.delete(id)
    scheduleMeasure()
  }, [scheduleMeasure])
  const replyRef = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) replyNodes.current.set(id, node)
    else replyNodes.current.delete(id)
    scheduleMeasure()
  }, [scheduleMeasure])

  const acceptTurn = useCallback((id: string, first: boolean) => {
    cancelJump()
    pendingAlignment.current = { id, first, frames: 0, stableFrames: 0, lastHeight: -1 }
    scheduleMeasure()
  }, [cancelJump, scheduleMeasure])

  const retryTurn = useCallback((id: string) => {
    cancelJump()
    pendingRetry.current = id
    scheduleMeasure()
  }, [cancelJump, scheduleMeasure])

  const jumpToLatest = useCallback(() => {
    cancelJump()
    const scroll = scrollNode.current
    const tail = tailNode.current
    if (!scroll || !tail) return
    const start = scroll.scrollTop
    const currentTarget = () => jumpTarget(contentTop(tail, scroll), scroll.clientHeight, scroll.scrollHeight)
    if (reducedMotion.current) {
      setProgrammaticScroll(scroll, currentTarget())
      scheduleMeasure()
      return
    }
    const distance = Math.abs(currentTarget() - start)
    const duration = Math.min(420, Math.max(180, distance / 2))
    const started = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      const target = currentTarget()
      setProgrammaticScroll(scroll, start + (target - start) * progress)
      scheduleMeasure()
      if (progress < 1) animation.current = requestAnimationFrame(tick)
      else animation.current = null
    }
    animation.current = requestAnimationFrame(tick)
  }, [cancelJump, scheduleMeasure, setProgrammaticScroll])

  useLayoutEffect(() => {
    const latest = turns.at(-1)?.id ?? null
    if (latest !== latestId.current) {
      latestId.current = latest
      maxReplyHeight.current = latest ? replyNodes.current.get(latest)?.getBoundingClientRect().height ?? 0 : 0
      pendingRetry.current = null
    }
    scheduleMeasure()
  }, [turns, activeTurnId, scheduleMeasure])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => { reducedMotion.current = media.matches }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const scroll = scrollElement
    if (!scroll || !textMode) return
    const markIntent = () => {
      userIntentUntil.current = performance.now() + 300
      suppressScrollUntil.current = 0
      cancelJump()
    }
    const onPointerDown = () => { pointerActive.current = true; markIntent() }
    const onPointerEnd = () => { pointerActive.current = false }
    const onTouchStart = () => { touchActive.current = true; markIntent() }
    const onTouchEnd = () => { touchActive.current = false }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markIntent()
    }
    const onScroll = () => {
      const top = scroll.scrollTop
      const now = performance.now()
      if ((now <= userIntentUntil.current || pointerActive.current || touchActive.current) && now > suppressScrollUntil.current) {
        writeSpacer(consumeUpwardScroll(spacer.current, lastScrollTop.current, top))
      }
      lastScrollTop.current = top
      scheduleMeasure()
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', markIntent, { passive: true, capture: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
    window.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true })
    window.addEventListener('pointerup', onPointerEnd, { passive: true, capture: true })
    window.addEventListener('pointercancel', onPointerEnd, { passive: true, capture: true })
    window.addEventListener('keydown', onKey, { capture: true })
    const scrollObserver = new ResizeObserver(scheduleMeasure)
    scrollObserver.observe(scroll)
    if (composerNode.current) scrollObserver.observe(composerNode.current)
    return () => {
      pointerActive.current = false
      touchActive.current = false
      scroll.removeEventListener('scroll', onScroll)
      window.removeEventListener('wheel', markIntent, true)
      window.removeEventListener('touchstart', onTouchStart, true)
      window.removeEventListener('touchend', onTouchEnd, true)
      window.removeEventListener('touchcancel', onTouchEnd, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerEnd, true)
      window.removeEventListener('pointercancel', onPointerEnd, true)
      window.removeEventListener('keydown', onKey, true)
      scrollObserver.disconnect()
    }
  }, [textMode, scrollElement, cancelJump, scheduleMeasure, writeSpacer])

  useEffect(() => {
    const latest = latestId.current
    const reply = latest ? replyNodes.current.get(latest) : null
    if (!reply || !textMode) return
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(reply)
    return () => observer.disconnect()
  }, [turns, textMode, scrollElement, scheduleMeasure])

  useEffect(() => {
    if (textMode) return
    cancelJump()
    pendingAlignment.current = null
  }, [textMode, cancelJump])

  useEffect(() => () => {
    cancelJump()
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [cancelJump])

  const busy = activeTurnId !== null
  const jumpControl = showJump && textMode ? (
    <button type="button" className="conversation-jump" onClick={jumpToLatest}
      aria-label="Jump to latest message" title="Jump to latest message">
      {busy ? <Ellipsis aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
    </button>
  ) : null
  const viewport: ConversationViewportBridge = {
    scrollRef, tailRef, composerRef, turnRef, replyRef, spacerPx, jumpControl,
  }
  return { viewport, acceptTurn, retryTurn, cancelJump }
}
