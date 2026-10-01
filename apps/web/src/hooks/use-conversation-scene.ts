import { useLayoutEffect, useState, type RefObject } from 'react'
import { idleSceneOffsets } from '@/lib/conversation-scene'

export function useConversationScene(
  idle: boolean,
  sceneRef: RefObject<HTMLElement | null>,
  footerRef: RefObject<HTMLDivElement | null>,
  orbRef: RefObject<HTMLDivElement | null>,
) {
  const [geometry, setGeometry] = useState({ footerHeight: 60, composerOffset: 0, orbOffset: 0 })

  useLayoutEffect(() => {
    const scene = sceneRef.current
    const footer = footerRef.current
    if (!scene || !footer) return
    let frame: number | null = null
    const measure = () => {
      frame = null
      const footerHeight = footer.offsetHeight
      const orbHeight = orbRef.current?.offsetHeight ?? 0
      const scroll = scene.querySelector<HTMLElement>('[data-conversation-scroll]')
      const inset = scroll ? Math.max(0, parseFloat(getComputedStyle(scroll).scrollPaddingTop) - 12) : 0
      setGeometry((previous) => {
        const next = {
          footerHeight,
          ...(idle ? idleSceneOffsets(scene.clientHeight, orbHeight, footerHeight, inset)
            : { composerOffset: previous.composerOffset, orbOffset: previous.orbOffset }),
        }
        return Object.keys(next).every((key) => next[key as keyof typeof next] === previous[key as keyof typeof next]) ? previous : next
      })
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(scene)
    observer.observe(footer)
    if (orbRef.current) observer.observe(orbRef.current)
    schedule()
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [idle, sceneRef, footerRef, orbRef])

  return geometry
}
