import { Shdr14 } from '@/components/ui/shdr-14'
import type { TurnStatus } from '@/components/text-conversation-view'

const stateColors = {
  thinking: { ink: '#18103b', paper: '#b6aaff' },
  speaking: { ink: '#2a1410', paper: '#ffd9a4' },
  idle: { ink: '#181b20', paper: '#c2ccd8' },
}

const stateVolumes = {
  thinking: { input: 0.45, output: 0.5 },
  speaking: { input: 0.65, output: 0.8 },
  idle: { input: 0, output: 0.3 },
}

export function CompactAgentOrb({ status }: { status: TurnStatus }) {
  const state = status === 'waiting' ? 'thinking' : status === 'streaming' ? 'speaking' : 'idle'
  return (
    <span className="conversation-compact-orb" aria-hidden="true">
      <Shdr14 size={24} state={state} stateColors={stateColors} stateVolumes={stateVolumes} maxDpr={2} />
    </span>
  )
}
