import { PhoneIcon, PhoneOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CallStatus } from '@/lib/live-session'

interface CallButtonProps {
  status: CallStatus
  hasError: boolean
  onClick: () => void
}

const labels: Record<CallStatus, string> = {
  idle: 'Start call',
  connecting: 'Cancel call',
  connected: 'End call',
  closing: 'Ending call',
  error: 'Try calling again',
}

export function CallButton({ status, hasError, onClick }: CallButtonProps) {
  const active = status === 'connecting' || status === 'connected' || status === 'closing'

  return (
    <Button
      type="button"
      variant="call"
      size="call"
      aria-label={labels[status]}
      aria-busy={status === 'connecting' || status === 'closing'}
      aria-describedby={hasError ? 'call-error' : undefined}
      data-active={active}
      data-state={status}
      disabled={status === 'closing'}
      onClick={onClick}
    >
      <PhoneIcon data-icon="call-start" aria-hidden="true" />
      <PhoneOffIcon data-icon="call-end" aria-hidden="true" />
    </Button>
  )
}
