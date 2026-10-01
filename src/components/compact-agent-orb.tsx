import { Shdr14 } from '@/components/ui/shdr-14'
import type { TurnStatus } from '@/components/text-conversation-view'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { composerMorph } from '@/lib/composer-size'
import { useAccentPreference } from '@/hooks/use-accent-preference'

const stateColors = {
  thinking: { ink: '#18103b', paper: '#b6aaff' },
  speaking: { ink: '#2a1410', paper: '#ffd9a4' },
  idle: { ink: '#181b20', paper: '#c2ccd8' },
}

const stateVolumes = {
  thinking: { input: 0.45, output: 0.5 },
  speaking: { input: 0.65, output: 0.8 },
  idle: { input: 0, output: 0.3 },
}

interface CompactAgentOrbProps {
  status: TurnStatus
}

export function CompactAgentOrb({ status }: CompactAgentOrbProps) {
  const { palette } = useAccentPreference()
  const state = status === 'waiting' ? 'thinking' : status === 'streaming' ? 'speaking' : 'idle'
  const reducedMotion = useReducedMotion()
  const anchorRef = useRef<HTMLDivElement>(null)
  const y = useMotionValue(0)
  const [positioned, setPositioned] = useState(false)
  const entrance = useMemo(() => status === 'streaming' && !reducedMotion
    ? { opacity: [1, 0.75, 1], scale: [1, 0.88, 1], filter: ['blur(0px)', 'blur(2px)', 'blur(0px)'] }
    : { opacity: 1, scale: 1, filter: 'blur(0px)' }, [status, reducedMotion])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const response = anchor?.parentElement
    if (!anchor || !response) return
    let target: number | null = null
    let movement: ReturnType<typeof animate> | null = null
    let frame: number | null = null
    const measure = () => {
      frame = null
      const next = anchor.offsetTop
      if (next === target) return
      movement?.stop()
      if (target === null || reducedMotion) y.set(next)
      else movement = animate(y, next, composerMorph)
      target = next
      setPositioned(true)
    }
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = requestAnimationFrame(measure)
    })
    observer.observe(response)
    measure()
    return () => {
      observer.disconnect()
      movement?.stop()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [reducedMotion, y])

  return (
    <>
    <div ref={anchorRef} className="conversation-orb-anchor" aria-hidden="true" />
    <motion.div
      className="conversation-compact-orb"
      aria-hidden="true"
      initial={false}
      style={{ y, visibility: positioned ? 'visible' : 'hidden' }}
      exit={{ opacity: 0 }}
      transition={reducedMotion ? { duration: 0 } : composerMorph}
    >
      <motion.span
        className="conversation-orb-entrance"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.75, filter: 'blur(4px)' }}
        animate={entrance}
        transition={composerMorph}
      >
        <Shdr14 size={32} state={state} stateColors={palette?.orbStates ?? stateColors} stateVolumes={stateVolumes} maxDpr={2} />
      </motion.span>
    </motion.div>
    </>
  )
}
