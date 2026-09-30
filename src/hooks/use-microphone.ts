import { useEffect, useState, useSyncExternalStore } from 'react'
import { Microphone } from '@/lib/microphone'

export function useMicrophone() {
  const [microphone] = useState(() => new Microphone())
  const snapshot = useSyncExternalStore(microphone.subscribe, microphone.getSnapshot)

  useEffect(() => {
    window.addEventListener('pagehide', microphone.stop)
    return () => {
      window.removeEventListener('pagehide', microphone.stop)
      microphone.stop()
    }
  }, [microphone])

  return { ...snapshot, toggle: microphone.toggle }
}
