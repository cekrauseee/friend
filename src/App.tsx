import { useEffect, useState, useSyncExternalStore } from 'react'
import { AnimatePresence } from 'motion/react'
import { TextConversationView } from '@/components/text-conversation-view'
import { VoiceStage } from '@/components/voice-stage'
import { useConversationViewport } from '@/hooks/use-conversation-viewport'
import { useLiveSession } from '@/hooks/use-live-session'
import { useTextConversation } from '@/lib/text-conversation'
import { createTextAccess } from '@/lib/text-access'
import './App.css'

function App() {
  const voice = useLiveSession()
  const [textAccess] = useState(() => createTextAccess())
  const access = useSyncExternalStore(textAccess.subscribe, textAccess.getSnapshot)
  const mode = useTextConversation((state) => state.mode)
  const turns = useTextConversation((state) => state.turns)
  const activeTurnId = useTextConversation((state) => state.activeTurnId)
  const [hasVisitedText, setHasVisitedText] = useState(false)
  const viewport = useConversationViewport(turns, activeTurnId, mode === 'text')

  useEffect(() => {
    const cancel = () => {
      useTextConversation.getState().cancelActive()
      textAccess.cancel(null)
    }
    window.addEventListener('pagehide', cancel)
    return () => {
      window.removeEventListener('pagehide', cancel)
      cancel()
    }
  }, [textAccess])

  const enterText = () => {
    void textAccess.enter(() => {
      voice.dispose()
      setHasVisitedText(true)
      useTextConversation.getState().enterText()
    })
  }

  const enterVoice = () => {
    viewport.cancelJump()
    useTextConversation.getState().enterVoice()
  }

  const sendText = (text: string) => {
    const id = useTextConversation.getState().sendText(text)
    if (id) viewport.acceptTurn(id, turns.length === 0)
    return id
  }

  const retryTurn = (id: string) => {
    const accepted = useTextConversation.getState().retryTurn(id)
    if (accepted) viewport.retryTurn(id)
    return accepted
  }

  return (
    <main className={`friend${mode === 'text' ? ' friend-text-mode' : ''}`} aria-label="Friend">
      <AnimatePresence initial={false} mode="wait">
        {mode === 'voice' ? (
          <VoiceStage
            key="voice"
            status={voice.status}
            error={voice.error}
            inputBands={voice.inputBands}
            outputLevel={voice.outputLevel}
            onToggleCall={voice.toggle}
            onEnterText={enterText}
            textAccessPending={access.pending}
            textAccessMessage={access.message}
            focusCall={hasVisitedText}
          />
        ) : (
          <TextConversationView
            key="text"
            turns={turns}
            activeTurnId={activeTurnId}
            onSend={sendText}
            onRetry={retryTurn}
            onEnterVoice={enterVoice}
            viewport={viewport.viewport}
          />
        )}
      </AnimatePresence>
    </main>
  )
}

export default App
