import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUpIcon, MessageCircleIcon, MicIcon, SquareIcon, CheckIcon, XIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group'
import { CallButton } from '@/components/call-button'
import { MicrophoneWaveform } from '@/components/microphone-waveform'
import type { CallStatus } from '@/lib/live-session'
import { Button } from '@/components/ui/button'
import { composerMorph, composerSize } from '@/lib/composer-size'
import type { CaptureSnapshot, CaptureIntent } from '@/lib/audio-capture'
import { surfaceHidden, surfaceVisible, surfaceExit, surfaceSpring, surfaceFade } from '@/lib/surface-motion'
import { interfaceSounds } from '@/lib/interface-sounds'

interface ConversationComposerProps {
  draft: string
  showCall: boolean
  dictation: CaptureSnapshot & { active: boolean; start: () => void; finish: (intent: CaptureIntent) => Promise<void>; cancel: () => void }
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
  showCall,
  dictation,
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
  const checking = voiceStatus === 'checking'
  const rowRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ height: 36, expanded: false, scrollable: false })
  const visibleSize = draft.length ? size : { height: 36, expanded: false, scrollable: false }
  const expanded = open && !calling && !dictation.active && visibleSize.expanded
  const editable = open && !calling && !dictation.active
  const controlTransition = reducedMotion ? surfaceFade : surfaceSpring
  const entrance = reducedMotion ? { opacity: 0 } : surfaceHidden
  const exit = reducedMotion ? { opacity: 0 } : surfaceExit
  const cancelRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (dictation.active) cancelRef.current?.focus({ preventScroll: true })
  }, [dictation.active])
  const measure = useCallback(() => {
    const input = inputRef.current
    const row = rowRef.current
    if (!input || !row || !editable) return
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
    input.style.width = `${Math.max(0, availableWidth - actionWidth - gap * actions.length)}px`
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
  }, [inputRef, editable])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [draft, measure, showCall])

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
    if (dictation.active || checking) return
    if (!draft.trim()) { onClose(); return }
    onSubmit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (checking || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    onSubmit()
  }

  return (
    <motion.form
      className="unified-composer-form"
      onSubmit={submit}
      onBlur={(event) => {
        if (!dictation.active && !event.currentTarget.contains(event.relatedTarget) && !draft.trim()) onClose()
      }}
      initial={false}
      animate={{ width: dictation.active ? '100%' : calling ? 236 : open ? '100%' : showCall ? 120 : 78 }}
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
            data-dictating={dictation.active}
            data-show-call={showCall}
            initial={false}
            animate={{ height: calling || dictation.active ? 36 : open ? visibleSize.height + (expanded ? 54 : 0) : 36, padding: expanded ? 6 : 0 }}
            transition={reducedMotion ? { duration: 0 } : composerMorph}
          >
            <div className="conversation-composer-surface" aria-hidden="true" />
            <motion.div
              className="conversation-composer-field-wrap"
              inert={!editable}
              aria-hidden={!editable}
              initial={false}
              animate={{
                height: calling || dictation.active ? 36 : visibleSize.height,
                opacity: editable ? 1 : 0,
                x: reducedMotion ? 0 : dictation.active ? 42 : 0,
                scaleX: reducedMotion ? 1 : editable ? 1 : 0.94,
                filter: reducedMotion || editable ? 'blur(0px)' : 'blur(3px)',
              }}
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
              inert={calling || dictation.active}
              aria-hidden={calling || dictation.active}
              initial={false}
              animate={{ opacity: calling || dictation.active ? 0 : 1 }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <Button type={open ? 'submit' : 'button'} variant={open ? 'default' : 'secondary'} size="icon-lg" aria-label={open ? 'Send message' : 'Open text chat'} aria-expanded={open} aria-controls={`${labelId}-input`} disabled={open && busy} aria-disabled={open && checking ? true : undefined} onClick={(event) => {
                if (checking && open) { event.preventDefault(); return }
                if (!open) { event.preventDefault(); onOpen() }
              }}>
                {open ? <ArrowUpIcon aria-hidden="true" /> : <MessageCircleIcon aria-hidden="true" />}
              </Button>
            </motion.div>
            <AnimatePresence initial={false}>
              {!calling && !dictation.active ? (
                <motion.div key="microphone" data-composer-action className="conversation-composer-microphone"
                  initial={entrance} animate={surfaceVisible} exit={exit} transition={controlTransition}>
                  <Button type="button" variant="secondary" size="icon-lg" aria-label="Start recording" title="Start recording" disabled={busy} aria-disabled={checking ? true : undefined} onClick={() => { if (!checking) dictation.start() }}>
                    <MicIcon aria-hidden="true" />
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <motion.div
              className="unified-voice-feedback"
              aria-hidden="true"
              initial={false}
              animate={{ width: calling ? 192 : 0, opacity: calling ? 1 : 0 }}
              transition={reducedMotion ? { duration: 0 } : composerMorph}
            >
              <MicrophoneWaveform bands={inputBands} />
            </motion.div>
            <AnimatePresence initial={false}>
              {showCall && !dictation.active ? (
                <motion.div key="call" data-composer-action className="conversation-composer-call"
                  initial={entrance} animate={surfaceVisible} exit={exit} transition={controlTransition}>
                  <CallButton size="icon-lg" status={voiceStatus} hasError={hasVoiceError} onClick={onToggleCall} />
                </motion.div>
              ) : null}
              {dictation.active ? (
                <motion.div key="dictation" className="conversation-dictation" data-status={dictation.status}
                  initial={entrance} animate={surfaceVisible} exit={exit} transition={controlTransition}
                  onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); dictation.cancel() } }}>
                  <Button ref={cancelRef} type="button" variant="secondary" size="icon-lg" aria-label="Cancel recording" title="Discard recording" onClick={dictation.cancel}>
                    <XIcon aria-hidden="true" />
                  </Button>
                  <motion.div className="conversation-dictation-feedback" aria-busy={dictation.status !== 'recording'}
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -42, scaleX: 0.94 }}
                    animate={{ opacity: 1, x: 0, scaleX: 1 }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -42, scaleX: 0.94 }}
                    transition={reducedMotion ? surfaceFade : composerMorph}>
                    <MicrophoneWaveform bands={dictation.inputBands} loading={dictation.status !== 'recording'} />
                  </motion.div>
                  <Button type="button" variant="secondary" size="icon-lg" aria-label="Stop recording and insert transcript" title="Stop and insert transcript" disabled={dictation.status !== 'recording'} onClick={() => { void dictation.finish('insert') }}>
                    <SquareIcon aria-hidden="true" />
                  </Button>
                  <Button type="button" size="icon-lg" aria-label="Accept recording and send message" title="Transcribe and send message" disabled={dictation.status !== 'recording' || busy} onClick={() => { void dictation.finish('send') }}>
                    <CheckIcon aria-hidden="true" />
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </motion.div>
        </Field>
      </FieldGroup>
      <AnimatePresence initial={false}>
        {dictation.error ? (
          <motion.div className="conversation-dictation-error" initial={entrance} animate={surfaceVisible} exit={exit} transition={controlTransition}>
            <p className="call-error" role="status">{dictation.error}</p>
            <Button type="button" variant="ghost" size="icon-lg" aria-label="Dismiss recording error" onClick={dictation.cancel}><XIcon aria-hidden="true" /></Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.form>
  )
}
