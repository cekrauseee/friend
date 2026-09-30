import { useEffect, useRef } from 'react'
import { MessageCircleIcon } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { CallButton } from '@/components/call-button'
import { FriendOrb } from '@/components/friend-orb'
import { MicrophoneWaveform } from '@/components/microphone-waveform'
import type { CallStatus } from '@/lib/live-session'

interface VoiceStageProps {
  status: CallStatus
  error: string | null
  inputBands: number[]
  outputLevel: number
  onToggleCall: () => void
  onEnterText: () => void
  textAccessPending?: boolean
  textAccessMessage?: string | null
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
  textAccessPending = false,
  textAccessMessage = null,
}: VoiceStageProps) {
  const callRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  const active = status === 'connecting' || status === 'connected' || status === 'closing'
  const announcement = status === 'connecting'
    ? 'Connecting. Activate the call button again to cancel.'
    : status === 'connected'
      ? 'Call connected.'
      : status === 'closing' ? 'Ending call.' : 'Call ended.'

  useEffect(() => {
    if (focusCall) callRef.current?.focus()
  }, [focusCall])

  return (
    <motion.section
      className="friend-voice max-w-lg mx-auto"
      aria-label="Voice conversation"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
      transition={{ duration: reducedMotion ? 0.12 : 0.24, ease: 'easeOut' }}
    >
      <div className="friend-stage">
        <FriendOrb level={outputLevel} />
        <div className="friend-controls">
          <div className="friend-action-row">
            <CallButton ref={callRef} status={status} hasError={Boolean(error)} onClick={onToggleCall} />
            <button type="button" className="friend-chat-button" aria-label={textAccessPending ? 'Cancel text chat sign-in' : 'Open text chat'} aria-describedby="text-access-status" aria-busy={textAccessPending} onClick={onEnterText}>
              <MessageCircleIcon aria-hidden="true" />
            </button>
          </div>
          {active ? <MicrophoneWaveform bands={inputBands} /> : null}
          <p id="call-error" className="call-error" role="status">{error}</p>
          <p id="text-access-status" className="call-error" role="status">{textAccessMessage}</p>
          <span className="sr-only" role="status">{announcement}</span>
        </div>
      </div>
    </motion.section>
  )
}
