import { MicIcon, MicOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Shdr14 } from '@/components/ui/shdr-14'
import { useMicrophone } from '@/hooks/use-microphone'
import './App.css'

function App() {
  const { status, level, error, toggle } = useMicrophone()
  const listening = status === 'listening'
  const requesting = status === 'requesting'
  const label = requesting
    ? 'Cancel microphone request'
    : listening
      ? 'Turn off microphone'
      : 'Turn on microphone'

  return (
    <main className="friend" aria-label="Friend">
      <div className="friend-stage">
        <Shdr14
          className="friend-orb"
          style={{ width: '100%', height: '100%' }}
          colors={{ ink: '#181b20', paper: '#c2ccd8' }}
          volumes={{ input: level, output: 0.3 + level * 0.25 }}
          params={{
            radius: 0.9 + level * 0.02,
            speed: 0.35 + level * 0.95,
            spin: 0.1 + level * 0.2,
            rim: 0,
            gain: 0.95,
          }}
        />

        <div className="friend-controls">
          <Button
            type="button"
            variant="microphone"
            size="microphone"
            aria-label={label}
            aria-pressed={listening}
            aria-busy={requesting}
            aria-describedby={error ? 'microphone-error' : undefined}
            data-state={status}
            onClick={toggle}
          >
            <MicIcon data-icon="microphone-off" aria-hidden="true" />
            <MicOffIcon data-icon="microphone-on" aria-hidden="true" />
          </Button>

          <p id="microphone-error" className="microphone-error" role="status">
            {error}
          </p>
          <span className="sr-only" role="status">
            {requesting
              ? 'Waiting for microphone permission. Activate again to cancel.'
              : listening
                ? 'Microphone on.'
                : 'Microphone off.'}
          </span>
        </div>
      </div>
    </main>
  )
}

export default App
