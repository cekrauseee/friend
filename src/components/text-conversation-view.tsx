import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { AssistantMarkdown } from '@/components/assistant-markdown'
import { CompactAgentOrb } from '@/components/compact-agent-orb'
import { ConversationComposer } from '@/components/conversation-composer'

export type TurnStatus = 'waiting' | 'streaming' | 'complete' | 'failed'

export interface ConversationTurn {
  id: string
  userText: string
  assistantText: string
  status: TurnStatus
  error: string | null
}

export interface ConversationViewportBridge {
  scrollRef?: Ref<HTMLDivElement>
  contentRef?: Ref<HTMLDivElement>
  turnRef?: (id: string, element: HTMLDivElement | null) => void
  replyRef?: (id: string, element: HTMLDivElement | null) => void
  composerRef?: Ref<HTMLDivElement>
  tailRef?: Ref<HTMLDivElement>
  spacerPx?: number
  jumpControl?: ReactNode
}

export interface TextConversationViewProps {
  turns: ConversationTurn[]
  activeTurnId: string | null
  onSend: (text: string) => string | null
  onRetry: (id: string) => boolean
  onEnterVoice: () => void
  viewport?: ConversationViewportBridge
}

interface TurnViewProps {
  turn: ConversationTurn
  latest: boolean
  active: boolean
  canRetry: boolean
  onRetry: (id: string) => boolean
  turnRef?: ConversationViewportBridge['turnRef']
  replyRef?: ConversationViewportBridge['replyRef']
}

function TurnView({ turn, latest, active, canRetry, onRetry, turnRef, replyRef }: TurnViewProps) {
  const attachTurn = useCallback((element: HTMLDivElement | null) => {
    turnRef?.(turn.id, element)
  }, [turn.id, turnRef])
  const attachReply = useCallback((element: HTMLDivElement | null) => {
    replyRef?.(turn.id, element)
  }, [turn.id, replyRef])
  const errorId = `turn-error-${turn.id}`

  return (
    <div ref={attachTurn} data-turn-id={turn.id} className="conversation-turn">
      <div className="conversation-user-row">
        <p className="conversation-user-bubble" dir="auto">{turn.userText}</p>
      </div>
      <div className="conversation-assistant" aria-busy={active} aria-describedby={turn.status === 'failed' && turn.error ? errorId : undefined}>
        <div ref={attachReply} data-assistant-reply={turn.id} className="conversation-reply">
          {turn.assistantText ? <AssistantMarkdown text={turn.assistantText} streaming={turn.status === 'streaming' && active} /> : null}
        </div>
        {latest ? <CompactAgentOrb status={turn.status} /> : null}
        {turn.status === 'failed' ? (
          <div className="conversation-turn-error" id={errorId}>
            <p>{turn.error || 'The response stopped. Please try again.'}</p>
            {canRetry ? <button type="button" onClick={() => onRetry(turn.id)}>Retry response</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function TextConversationView({
  turns,
  activeTurnId,
  onSend,
  onRetry,
  onEnterVoice,
  viewport,
}: TextConversationViewProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const reducedMotion = useReducedMotion()
  const latest = turns.at(-1)
  const announcement = latest?.status === 'waiting' ? 'Message sent. Thinking.'
    : latest?.status === 'streaming' ? 'Answer started.'
      : latest?.status === 'complete' ? 'Answer complete.'
        : latest?.status === 'failed' ? 'Answer failed. Retry is available.' : ''

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  function sendDraft() {
    const acceptedId = onSend(draft)
    if (acceptedId !== null) setDraft('')
  }

  return (
    <motion.section
      className="text-conversation"
      data-empty={turns.length === 0}
      aria-label="Text conversation"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{ duration: reducedMotion ? 0.12 : 0.22, ease: 'easeOut' }}
    >
      <div ref={viewport?.scrollRef} className="conversation-scroll" data-conversation-scroll>
        <div ref={viewport?.contentRef} className="conversation-content max-w-lg mx-auto" data-conversation-content>
          {turns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              latest={turn.id === latest?.id}
              active={turn.id === activeTurnId}
              canRetry={turn.id === latest?.id && activeTurnId === null}
              onRetry={onRetry}
              turnRef={viewport?.turnRef}
              replyRef={viewport?.replyRef}
            />
          ))}
          <div ref={viewport?.tailRef} data-conversation-tail aria-hidden="true" />
          <div data-conversation-spacer aria-hidden="true" style={{ blockSize: Math.max(0, viewport?.spacerPx ?? 0) }} />
        </div>
      </div>
      <div className="conversation-footer">
        {viewport?.jumpControl ? <div className="conversation-jump-slot">{viewport.jumpControl}</div> : null}
        <motion.div
          ref={viewport?.composerRef}
          className="conversation-composer-wrap max-w-lg mx-auto"
          data-conversation-composer
          layout={reducedMotion ? false : 'position'}
          transition={{ layout: { duration: 0.24, ease: 'easeOut' } }}
        >
          <ConversationComposer
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={sendDraft}
            onEnterVoice={onEnterVoice}
            busy={activeTurnId !== null}
            inputRef={inputRef}
          />
        </motion.div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </motion.section>
  )
}
