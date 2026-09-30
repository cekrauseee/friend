import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUpIcon, MessageCircleIcon } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group'
import { CallButton } from '@/components/call-button'
import { MicrophoneWaveform } from '@/components/microphone-waveform'
import type { CallStatus } from '@/lib/live-session'
import { Button } from '@/components/ui/button'
import { composerMorph, composerSize } from '@/lib/composer-size'
import { interfaceSounds } from '@/lib/interface-sounds'

interface ConversationComposerProps {
  draft: string
  onDraftChange: (draft: string) => void
  onSubmit: () => void
  onToggleCall: () => void
  voiceStatus: CallStatus
  inputBands: number[]
  hasVoiceError: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  busy: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
}

export function ConversationComposer({
  draft,
  onDraftChange,
  onSubmit,
  onToggleCall,
  voiceStatus,
  inputBands,
  hasVoiceError,
  open,
  onOpen,
  onClose,
  busy,
  inputRef,
}: ConversationComposerProps) {
  const labelId = useId()
  const reducedMotion = useReducedMotion()
  const calling = voiceStatus === 'connecting' || voiceStatus === 'connected' || voiceStatus === 'closing'
  const rowRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ height: 36, expanded: false, scrollable: false })
  const visibleSize = draft.length ? size : { height: 36, expanded: false, scrollable: false }
  const expanded = open && !calling && visibleSize.expanded
  const measure = useCallback(() => {
    const input = inputRef.current
    const row = rowRef.current
    if (!input || !row || !open) return
    const styles = getComputedStyle(input)
    const previousHeight = input.style.height
    const previousWidth = input.style.width
    const previousFlex = input.style.flex
    const previousOverflow = input.style.overflowY
    const previousScroll = input.scrollTop
    const surface = getComputedStyle(input.parentElement!)
    const border = parseFloat(surface.borderTopWidth) + parseFloat(surface.borderBottomWidth)
    // Measure natural content without the animated surface's current height.
    input.style.overflowY = 'hidden'
    input.style.height = '0px'
    input.style.flex = 'none'
    const actions = [...row.querySelectorAll<HTMLElement>('[data-composer-action]')]
    const actionWidth = actions.reduce((width, action) => width + action.getBoundingClientRect().width, 0)
    const gap = parseFloat(getComputedStyle(row).columnGap)
    const lineHeight = parseFloat(styles.lineHeight)
    const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom) + border
    // Keep the expansion threshold tied to the pill width, even after the
    // expanded field gains width. Otherwise wrapping could toggle it endlessly.
    const availableWidth = input.closest('form')!.parentElement!.clientWidth
    input.style.width = `${Math.max(0, availableWidth - actionWidth - gap * 2)}px`
    const compactHeight = input.scrollHeight + border
    const expanded = composerSize(compactHeight, lineHeight, padding).expanded
    if (expanded) input.style.width = `${Math.max(0, availableWidth - 12)}px`
    const next = composerSize(
      input.scrollHeight + border,
      lineHeight,
      padding,
      192,
      compactHeight,
    )
    input.style.height = previousHeight
    input.style.width = previousWidth
    input.style.flex = previousFlex
    input.style.overflowY = previousOverflow
    input.scrollTop = next.scrollable ? previousScroll : 0
    setSize((previous) => previous.height === next.height && previous.expanded === next.expanded && previous.scrollable === next.scrollable
      ? previous : next)
  }, [inputRef, open])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [draft, measure])

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    let width = row.getBoundingClientRect().width
    let frame: number | null = null
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width
      if (nextWidth === width) return
      width = nextWidth
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(row)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [inputRef, measure])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.trim()) { onClose(); return }
    onSubmit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    onSubmit()
  }

  return (
    <motion.form
      className="unified-composer-form"
      onSubmit={submit}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !draft.trim()) onClose()
      }}
      initial={false}
      animate={{ width: calling ? 236 : open ? '100%' : 78 }}
      transition={reducedMotion ? { duration: 0 } : composerMorph}
    >
      <FieldGroup>
        <Field>
          <FieldLabel id={labelId} htmlFor={`${labelId}-input`} className="sr-only">Message</FieldLabel>
          <motion.div
            ref={rowRef}
            className="conversation-composer-row"
            data-expanded={expanded}
            data-open={open}
            data-calling={calling}
            initial={false}
            animate={{ height: calling ? 36 : open ? visibleSize.height + (expanded ? 54 : 0) : 36, padding: expanded ? 6 : 0 }}
            transition={reducedMotion ? { duration: 0 } : composerMorph}
          >
            <div className="conversation-composer-surface" aria-hidden="true" />
            <motion.div
              className="conversation-composer-field-wrap"
              inert={!open}
              aria-hidden={!open}
              initial={false}
              animate={{ height: visibleSize.height }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <InputGroup className="conversation-composer-field h-full has-[>textarea]:h-full" aria-labelledby={labelId}>
                <InputGroupTextarea
                  ref={inputRef}
                  id={`${labelId}-input`}
                  name="message"
                  rows={1}
                  className="conversation-composer-input"
                  style={{ overflowY: size.scrollable ? 'auto' : 'hidden' }}
                  value={draft}
                  onChange={(event) => {
                    onDraftChange(event.target.value)
                    interfaceSounds.play('composerTyping', true)
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask anything"
                  aria-labelledby={labelId}
                />
              </InputGroup>
            </motion.div>
            <motion.div
              data-composer-action
              className="conversation-composer-send"
              inert={calling}
              aria-hidden={calling}
              initial={false}
              animate={{ opacity: calling ? 0 : 1 }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <Button type={open ? 'submit' : 'button'} variant={open ? 'default' : 'secondary'} size="icon-lg" aria-label={open ? 'Send message' : 'Open text chat'} aria-expanded={open} aria-controls={`${labelId}-input`} disabled={open && busy} onClick={(event) => { if (!open) { event.preventDefault(); onOpen() } }}>
                {open ? <ArrowUpIcon aria-hidden="true" /> : <MessageCircleIcon aria-hidden="true" />}
              </Button>
            </motion.div>
            <motion.div
              className="unified-voice-feedback"
              aria-hidden="true"
              initial={false}
              animate={{ width: calling ? 192 : 0, opacity: calling ? 1 : 0 }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <MicrophoneWaveform bands={inputBands} />
            </motion.div>
            <motion.div
              data-composer-action
              className="conversation-composer-call"
              initial={false}
              animate={{ y: 0 }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <CallButton size="icon-lg" status={voiceStatus} hasError={hasVoiceError} onClick={() => {
                if (!draft.trim()) onClose()
                onToggleCall()
              }} />
            </motion.div>
          </motion.div>
        </Field>
      </FieldGroup>
    </motion.form>
  )
}
