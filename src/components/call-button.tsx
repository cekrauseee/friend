import { AudioLinesIcon, PhoneOffIcon } from 'lucide-react'
import type { Ref } from 'react'
import { Button } from '@/components/ui/button'
import type { CallStatus } from '@/lib/live-session'

interface CallButtonProps {
  ref?: Ref<HTMLButtonElement>
  size?: 'icon' | 'icon-lg'
  status: CallStatus
  hasError: boolean
  onClick: () => void
}

const labels: Record<CallStatus, string> = {
  idle: 'Start call',
  checking: 'Cancel call check',
  connecting: 'Cancel call',
  connected: 'End call',
  closing: 'Ending call',
  error: 'Try calling again',
}

export function CallButton({ ref, size = 'icon-lg', status, hasError, onClick }: CallButtonProps) {
  const active = status === 'connecting' || status === 'connected' || status === 'closing'

  return (
    <Button
      type="button"
      ref={ref}
      variant={active ? 'destructive' : 'secondary'}
      data-action="call"
      size={size}
      aria-label={labels[status]}
      aria-busy={status === 'checking' || status === 'connecting' || status === 'closing'}
      aria-describedby={hasError ? 'call-error' : undefined}
      data-active={active}
      data-state={status}
      disabled={status === 'closing'}
      onClick={onClick}
    >
      <AudioLinesIcon data-icon="call-start" aria-hidden="true" />
      <PhoneOffIcon data-icon="call-end" aria-hidden="true" />
    </Button>
  )
}
