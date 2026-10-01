import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ConversationTurn, ConversationViewportBridge } from '@/components/text-conversation-view'
import { attachConversationScrollMotion } from '@/lib/conversation-scroll-motion'
import { attachConversationSpacer } from '@/lib/conversation-spacer'

export function useConversationViewport(turns: ConversationTurn[]) {
  const motion = useRef<ReturnType<typeof attachConversationScrollMotion> | null>(null)
  const spacer = useRef<ReturnType<typeof attachConversationSpacer> | null>(null)
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    spacer.current?.dispose()
    motion.current?.dispose()
    motion.current = node ? attachConversationScrollMotion(node) : null
    spacer.current = node && motion.current ? attachConversationSpacer(node, motion.current) : null
  }, [])
  const cancelJump = useCallback(() => spacer.current?.scrollIntent(), [])
  const acceptTurn = useCallback((id: string) => spacer.current?.acceptTurn(id), [])
  const retryTurn = useCallback(() => spacer.current?.retryTurn(), [])
  const jumpToLatest = useCallback(() => spacer.current?.jumpToLatest(), [])

  useLayoutEffect(() => { spacer.current?.measure() }, [turns])
  useEffect(() => () => { spacer.current?.dispose(); motion.current?.dispose() }, [])

  const viewport: ConversationViewportBridge = { scrollRef, onScrollIntent: cancelJump, jumpToLatest }
  return { viewport, acceptTurn, retryTurn, cancelJump }
}
