import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence } from 'motion/react'
import { TextConversationView } from '@/components/text-conversation-view'
import { useConversationViewport } from '@/hooks/use-conversation-viewport'
import { useLiveSession } from '@/hooks/use-live-session'
import { useTextConversation } from '@/lib/text-conversation'
import { createTextAccess } from '@/lib/text-access'
import { GlobalLoading } from '@/components/global-loading'
import { AuthenticationDialog } from '@/components/authentication-dialog'
import { AccentPicker } from '@/components/accent-picker'
import { SoundToggle } from '@/components/sound-toggle'
import { interfaceSounds } from '@/lib/interface-sounds'
import { conversationOutcomeSound } from '@/lib/conversation-sound'
import './App.css'

function App() {
  const voice = useLiveSession()
  const [textAccess] = useState(() => createTextAccess())
  const access = useSyncExternalStore(textAccess.subscribe, textAccess.getSnapshot)
  const turns = useTextConversation((state) => state.turns)
  const activeTurnId = useTextConversation((state) => state.activeTurnId)
  const starting = access.checking || (access.authenticated === null && !access.message)
  const viewport = useConversationViewport(turns)
  const previousFeedback = useRef({ voiceStatus: voice.status, voiceError: voice.error, authenticated: access.authenticated })

  useEffect(() => {
    const previous = previousFeedback.current
    interfaceSounds.setVoiceActive(['checking', 'connecting', 'connected', 'closing'].includes(voice.status))
    if (voice.status === 'error' && voice.error && voice.error !== previous.voiceError) interfaceSounds.play('error')
    else if (voice.status === 'idle' && ['connected', 'closing'].includes(previous.voiceStatus)) interfaceSounds.play('callEnded')
    if (access.authenticated === true && previous.authenticated !== true) interfaceSounds.play('authenticated')
    previousFeedback.current = { voiceStatus: voice.status, voiceError: voice.error, authenticated: access.authenticated }
  }, [voice.status, voice.error, access.authenticated])

  useEffect(() => {
    void textAccess.check()
    const unsubscribe = useTextConversation.subscribe((state, previous) => {
      const outcome = conversationOutcomeSound(previous.turns.at(-1), state.turns.at(-1))
      if (outcome) interfaceSounds.play(outcome)
    })
    const cancel = () => {
      useTextConversation.getState().cancelActive()
      textAccess.cancel(null)
      interfaceSounds.stop()
    }
    window.addEventListener('pagehide', cancel)
    return () => {
      window.removeEventListener('pagehide', cancel)
      unsubscribe()
      cancel()
    }
  }, [textAccess])

  const toggleVoice = () => {
    interfaceSounds.setVoiceActive(true)
    if (voice.status === 'idle' || voice.status === 'error') useTextConversation.getState().cancelActive()
    voice.toggle()
  }

  const sendText = (text: string) => {
    if (access.authenticated !== true) return null
    voice.dispose()
    interfaceSounds.setVoiceActive(false)
    const id = useTextConversation.getState().sendText(text)
    if (id) { viewport.acceptTurn(id); interfaceSounds.play('send', true) }
    return id
  }

  const retryTurn = (id: string) => {
    if (access.authenticated !== true) return false
    const accepted = useTextConversation.getState().retryTurn(id)
    if (accepted) { viewport.retryTurn(); interfaceSounds.play('retry', true) }
    return accepted
  }

  return (
    <main className="dot dot-text-mode" aria-label="Dot" aria-busy={starting}
      onPointerDownCapture={() => { void interfaceSounds.unlock() }}
      onKeyDownCapture={() => { void interfaceSounds.unlock() }}>
      <div className="appearance-controls" data-appearance-control>
        <AccentPicker />
        <SoundToggle />
      </div>
      <div className="contents" inert={access.authenticated !== true}>
        <TextConversationView
          revealed={!starting}
          ready={access.authenticated === true}
          turns={turns}
          activeTurnId={activeTurnId}
          onSend={sendText}
          onRetry={retryTurn}
          onToggleCall={toggleVoice}
          voiceStatus={voice.status}
          voiceError={voice.error}
          inputBands={voice.inputBands}
          outputLevel={voice.outputLevel}
          viewport={viewport.viewport}
        />
      </div>
      <AnimatePresence>
        {starting ? <GlobalLoading key="startup-loading" /> : null}
      </AnimatePresence>
      <AuthenticationDialog
        access={access}
        onSignIn={() => { void textAccess.enter(() => {}) }}
        onRetry={() => { void textAccess.check() }}
        onCancel={() => textAccess.cancel()}
      />
    </main>
  )
}

export default App
