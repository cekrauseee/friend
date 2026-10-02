import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
import { animateDelta } from '@/lib/markdown-deltas'

export function MarkdownDelta({ id, startedAt, children }: { id: string; startedAt: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reducedMotion = useReducedMotion()

  useLayoutEffect(() => {
    // Reparsed Markdown and asynchronously highlighted code resume the same
    // delta's timeline. Completion never switches to a different render tree.
    return animateDelta(ref.current, startedAt, Boolean(reducedMotion))
  }, [id, startedAt, reducedMotion])

  return <span ref={ref} data-markdown-delta={id}>{children}</span>
}
