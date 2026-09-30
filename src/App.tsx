import { CallButton } from '@/components/call-button'
import { FriendOrb } from '@/components/friend-orb'
import { MicrophoneWaveform } from '@/components/microphone-waveform'
import { useLiveSession } from '@/hooks/use-live-session'
import './App.css'

function App() {
  const { status, error, inputBands, outputLevel, toggle } = useLiveSession()
  const active = status === 'connecting' || status === 'connected' || status === 'closing'
  const announcement = status === 'connecting'
    ? 'Connecting. Activate the call button again to cancel.'
    : status === 'connected'
      ? 'Call connected.'
      : status === 'closing' ? 'Ending call.' : 'Call ended.'

  return (
    <main className="friend" aria-label="Friend">
      <div className="friend-stage">
        <FriendOrb level={outputLevel} />
        <div className="friend-controls">
          <CallButton status={status} hasError={Boolean(error)} onClick={toggle} />
          {active ? <MicrophoneWaveform bands={inputBands} /> : null}
          <p id="call-error" className="call-error" role="status">{error}</p>
          <span className="sr-only" role="status">{announcement}</span>
        </div>
      </div>
    </main>
  )
}

export default App
