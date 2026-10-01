import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AssistantMarkdown } from '@/components/assistant-markdown'
import { CompactAgentOrb } from '@/components/compact-agent-orb'
import { ConversationComposer } from '@/components/conversation-composer'
import { DotOrb } from '@/components/dot-orb'
import type { CallStatus } from '@/lib/live-session'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { composerMorph } from '@/lib/composer-size'
import { conversationPresentation } from '@/lib/conversation-presentation'
import { useConversationScene } from '@/hooks/use-conversation-scene'
import { useTransientError } from '@/hooks/use-transient-error'
import { MessageScroller, MessageScrollerProvider, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from '@/components/ui/message-scroller'
import { Ellipsis } from 'lucide-react'
import { interfaceSounds } from '@/lib/interface-sounds'
import { useComposerShortcuts } from '@/hooks/use-composer-shortcuts'
import { useComposerDictation } from '@/hooks/use-composer-dictation'
import { surfaceHidden, surfaceVisible, surfaceExit, surfaceSpring, surfaceFade } from '@/lib/surface-motion'
import type { MarkdownDelta } from '@/lib/markdown-deltas'

const MotionMessageScroller = motion.create(MessageScroller)

export type TurnStatus = 'waiting' | 'streaming' | 'complete' | 'failed'

export interface ConversationTurn {
  id: string
  userText: string
  assistantText: string
  assistantDeltas?: MarkdownDelta[]
  status: TurnStatus
  error: string | null
  presentationAccelerated?: boolean
}

export interface ConversationViewportBridge {
  scrollRef?: Ref<HTMLDivElement>
  onScrollIntent?: () => void
  jumpToLatest?: () => void
}

export interface TextConversationViewProps {
  revealed?: boolean
  ready?: boolean
  turns: ConversationTurn[]
  activeTurnId: string | null
  onSend: (text: string) => string | null
  onRetry: (id: string) => boolean
  onToggleCall: () => void
  voiceStatus: CallStatus
  voiceError: string | null
  inputBands: number[]
  outputLevel: number
  viewport?: ConversationViewportBridge
}

interface TurnViewProps {
  turn: ConversationTurn
  latest: boolean
  active: boolean
  canRetry: boolean
  onRetry: (id: string) => boolean
}

function TurnView({ turn, latest, active, canRetry, onRetry }: TurnViewProps) {
  const reducedMotion = useReducedMotion()
  const previousText = useRef(active && turn.status === 'streaming' ? '' : turn.assistantText)
  const errorId = `turn-error-${turn.id}`

  useEffect(() => {
    if (active && turn.status === 'streaming' && turn.assistantText !== previousText.current) {
      const delta = turn.assistantText.startsWith(previousText.current)
        ? turn.assistantText.slice(previousText.current.length) : turn.assistantText
      interfaceSounds.playAgentTyping(turn.id, delta, turn.presentationAccelerated)
    }
    if (!active || turn.status !== 'streaming') interfaceSounds.resetAgentTyping(turn.id)
    previousText.current = turn.assistantText
  }, [active, turn.status, turn.assistantText, turn.id, turn.presentationAccelerated])

  return (
    <MessageScrollerItem messageId={turn.id} scrollAnchor={false} data-turn-id={turn.id} className="conversation-turn">
      <motion.div
        className="conversation-user-row"
        initial={active ? (reducedMotion ? { opacity: 0 } : surfaceHidden) : false}
        animate={surfaceVisible}
        transition={reducedMotion ? surfaceFade : surfaceSpring}
        style={{ transformOrigin: 'right bottom' }}
      >
        <Bubble align="end" variant="secondary">
          <BubbleContent asChild>
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{turn.userText}</p>
          </BubbleContent>
        </Bubble>
      </motion.div>
      <div className="conversation-assistant" aria-busy={active} aria-describedby={turn.status === 'failed' && turn.error ? errorId : undefined}>
        <div data-assistant-reply={turn.id} className="conversation-reply" dir="auto">
          {turn.assistantText ? <AssistantMarkdown text={turn.assistantText} streaming={turn.status === 'streaming' && active} deltas={turn.assistantDeltas} /> : null}
        </div>
        <AnimatePresence initial={active}>
          {latest ? <CompactAgentOrb key={turn.id} status={turn.status} /> : null}
        </AnimatePresence>
        {turn.status === 'failed' ? (
          <div className="conversation-turn-error" id={errorId}>
            <p>{turn.error || 'The response stopped. Please try again.'}</p>
            {canRetry ? <Button type="button" variant="secondary" onClick={() => onRetry(turn.id)}>Retry response</Button> : null}
          </div>
        ) : null}
      </div>
    </MessageScrollerItem>
  )
}

export function TextConversationView({
  revealed = true,
  ready = true,
  turns,
  activeTurnId,
  onSend,
  onRetry,
  onToggleCall,
  voiceStatus,
  voiceError,
  inputBands,
  outputLevel,
  viewport,
}: TextConversationViewProps) {
  const [draft, setDraft] = useState('')
  const [requestedOpen, setRequestedOpen] = useState(false)
  const displayedVoiceError = useTransientError(voiceError, voiceStatus)
  const { showLargeOrb, composerOpen, calling } = conversationPresentation(turns.length, voiceStatus, requestedOpen, draft)
  const voiceBusy = calling || voiceStatus === 'checking'
  const sceneRef = useRef<HTMLElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const orbRef = useRef<HTMLDivElement>(null)
  const scene = useConversationScene(showLargeOrb, sceneRef, footerRef, orbRef)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const openComposer = useCallback(() => setRequestedOpen(true), [])
  const dictation = useComposerDictation({ draft, enabled: ready && !voiceBusy && activeTurnId === null, onDraftChange: setDraft, onSend, onOpen: openComposer })
  function cancelDictation() {
    dictation.cancel()
    if (!turns.length && !draft.trim()) setRequestedOpen(false)
    else requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }
  const callAllowed = useRef(false)
  useLayoutEffect(() => { callAllowed.current = !dictation.active && turns.length === 0 }, [dictation.active, turns.length])
  const toggleCall = () => { if (callAllowed.current) { dictation.cancel(); onToggleCall() } }
  useComposerShortcuts({ enabled: ready && !voiceBusy && !dictation.active, open: composerOpen, inputRef, onOpen: openComposer, onDraftChange: setDraft })
  const reducedMotion = useReducedMotion()
  const latest = turns.at(-1)
  const voiceAnnouncement = voiceStatus === 'checking' ? 'Checking call configuration. Activate the call button again to cancel.'
    : voiceStatus === 'connecting' ? 'Connecting call.'
    : voiceStatus === 'connected' ? 'Call connected.'
      : voiceStatus === 'closing' ? 'Ending call.' : 'Call ended.'
  const announcement = latest?.status === 'waiting' ? 'Message sent. Thinking.'
    : latest?.status === 'streaming' ? 'Answer started.'
      : latest?.status === 'complete' ? 'Answer complete.'
        : latest?.status === 'failed' ? 'Answer failed. Retry is available.' : ''

  useEffect(() => {
    if (!ready || !composerOpen || dictation.active) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [ready, composerOpen, dictation.active])

  function sendDraft() {
    if (dictation.active || voiceStatus === 'checking') return
    const acceptedId = onSend(draft)
    if (acceptedId !== null) setDraft('')
  }

  return (
    <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start" scrollMargin={4} scrollPreviousItemPeek={0} scrollEdgeThreshold={80}>
      <motion.section
        ref={sceneRef}
        className="text-conversation"
        data-empty={turns.length === 0}
        aria-label="Conversation"
        initial={reducedMotion ? { opacity: 0 } : { ...surfaceHidden, scale: 0.985 }}
        animate={reducedMotion ? { opacity: revealed ? 1 : 0 } : revealed ? surfaceVisible : { ...surfaceHidden, scale: 0.985 }}
        exit={reducedMotion ? { opacity: 0 } : surfaceExit}
        transition={{ ...(reducedMotion ? surfaceFade : surfaceSpring), delay: revealed ? 0.1 : 0 }}
      >
        <AnimatePresence>
          {showLargeOrb ? (
            <motion.div
              key="initial-orb"
              ref={orbRef}
              className="unified-orb-stage"
              initial={reducedMotion ? { opacity: 0 } : { ...surfaceHidden, filter: 'blur(4px)' }}
              animate={{ ...(reducedMotion || revealed ? surfaceVisible : surfaceHidden), marginTop: scene.orbOffset, filter: revealed || reducedMotion ? 'blur(0px)' : 'blur(4px)' }}
              exit={reducedMotion ? { opacity: 0 } : { ...surfaceExit, filter: 'blur(4px)' }}
              transition={reducedMotion ? { ...surfaceFade, marginTop: { duration: 0 } } : { ...surfaceSpring, marginTop: composerMorph }}
            >
              <DotOrb level={outputLevel} />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <MotionMessageScroller
          className="conversation-scroller"
          inert={showLargeOrb}
          aria-hidden={showLargeOrb}
          style={{ bottom: scene.footerHeight + 8 }}
          initial={false}
          animate={{ opacity: showLargeOrb ? 0 : 1 }}
          transition={reducedMotion ? { duration: 0.1 } : { ...composerMorph, delay: showLargeOrb ? 0 : 0.06 }}
        >
          <MessageScrollerViewport
            ref={viewport?.scrollRef}
            preserveScrollOnPrepend={false}
            className="conversation-scroll"
            data-conversation-scroll
            onWheel={viewport?.onScrollIntent}
            onTouchMove={viewport?.onScrollIntent}
            onPointerDown={viewport?.onScrollIntent}
            onKeyDown={(event) => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) viewport?.onScrollIntent?.()
            }}
          >
            <MessageScrollerContent className="conversation-content mx-auto" data-conversation-content aria-busy={activeTurnId !== null}>
              {turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  latest={turn.id === latest?.id}
                  active={turn.id === activeTurnId}
                  canRetry={turn.id === latest?.id && activeTurnId === null}
                  onRetry={onRetry}
                />
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MotionMessageScroller>
        <motion.div
          ref={footerRef}
          className="conversation-footer"
          data-idle={showLargeOrb}
          initial={false}
          animate={{ y: showLargeOrb ? scene.composerOffset : 0 }}
          transition={reducedMotion ? { duration: 0 } : showLargeOrb ? composerMorph : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="conversation-jump-slot">
          {!showLargeOrb ? <MessageScrollerButton variant="outline" size="icon-lg" className="conversation-jump"
            onClick={(event) => {
              if (viewport?.jumpToLatest) { event.preventDefault(); viewport.jumpToLatest() }
            }}
              aria-label="Jump to latest message" title="Jump to latest message">
              {activeTurnId !== null ? <Ellipsis aria-hidden="true" /> : undefined}
            </MessageScrollerButton> : null}
          </div>
          <motion.div
            className="conversation-composer-wrap max-w-md mx-auto"
            data-conversation-composer
          >
            <ConversationComposer
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={sendDraft}
              onToggleCall={toggleCall}
              showCall={turns.length === 0}
              dictation={{ ...dictation, cancel: cancelDictation }}
              voiceStatus={voiceStatus}
              inputBands={inputBands}
              hasVoiceError={Boolean(displayedVoiceError)}
              open={composerOpen}
              onOpen={() => { setRequestedOpen(true); interfaceSounds.play('openComposer', true) }}
              onClose={() => { if (!turns.length) setRequestedOpen(false) }}
              busy={!ready || activeTurnId !== null}
              inputRef={inputRef}
            />
          </motion.div>
          <motion.div
            className="unified-call-error"
            aria-hidden={!displayedVoiceError}
            initial={false}
            animate={{ height: displayedVoiceError ? 'auto' : 0, marginTop: displayedVoiceError ? 16 : 0, opacity: displayedVoiceError ? 1 : 0 }}
            transition={reducedMotion ? { duration: 0 } : composerMorph}
          >
            <p id="call-error" className="call-error" role="status">{voiceError}</p>
          </motion.div>
        </motion.div>
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
        <span className="sr-only" role="status" aria-live="polite">{voiceAnnouncement}</span>
        <span className="sr-only" role="status" aria-live="polite">{dictation.status === 'starting' ? 'Waiting for microphone access.' : dictation.status === 'recording' ? 'Recording. Stop to insert the transcript, or accept to send.' : dictation.status === 'processing' ? 'Transcribing recording.' : ''}</span>
      </motion.section>
    </MessageScrollerProvider>
  )
}
