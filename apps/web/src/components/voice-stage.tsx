import { useEffect, useRef } from 'react'
import { MessageCircleIcon } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { CallButton } from '@/components/call-button'
import { Button } from '@/components/ui/button'
import { DotOrb } from '@/components/dot-orb'
import { MicrophoneWaveform } from '@/components/microphone-waveform'
import type { CallStatus } from '@/lib/live-session'

interface VoiceStageProps {
  status: CallStatus
  error: string | null
  inputBands: number[]
  outputLevel: number
  onToggleCall: () => void
  onEnterText: () => void
  focusCall?: boolean
}

export function VoiceStage({
  status,
  error,
  inputBands,
  outputLevel,
  onToggleCall,
  onEnterText,
  focusCall = false,
}: VoiceStageProps) {
  const callRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  const active = status === 'connecting' || status === 'connected' || status === 'closing'
  const announcement = status === 'checking'
    ? 'Checking call configuration. Activate the call button again to cancel.'
    : status === 'connecting'
    ? 'Connecting. Activate the call button again to cancel.'
    : status === 'connected'
      ? 'Call connected.'
      : status === 'closing' ? 'Ending call.' : 'Call ended.'

  useEffect(() => {
    if (focusCall) callRef.current?.focus()
  }, [focusCall])

  return (
    <motion.section
      className="dot-voice max-w-md mx-auto"
      aria-label="Voice conversation"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
      transition={{ duration: reducedMotion ? 0.12 : 0.24, ease: 'easeOut' }}
    >
      <div className="dot-stage">
        <DotOrb level={outputLevel} />
        <div className="dot-controls">
          <div className="dot-action-row">
            <CallButton ref={callRef} status={status} hasError={Boolean(error)} onClick={onToggleCall} />
            <Button type="button" variant="secondary" size="icon-lg" aria-label="Back to text chat" onClick={onEnterText}>
              <MessageCircleIcon aria-hidden="true" />
            </Button>
          </div>
          {active ? <MicrophoneWaveform bands={inputBands} /> : null}
          <p id="call-error" className="call-error" role="status">{error}</p>
          <span className="sr-only" role="status">{announcement}</span>
        </div>
      </div>
    </motion.section>
  )
}
