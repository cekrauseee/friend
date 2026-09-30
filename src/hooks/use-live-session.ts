import { useEffect, useState, useSyncExternalStore } from 'react'
import { LiveSession } from '@/lib/live-session'

export function useLiveSession() {
  const [session] = useState(() => new LiveSession())
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)

  useEffect(() => {
    window.addEventListener('pagehide', session.dispose)
    return () => {
      window.removeEventListener('pagehide', session.dispose)
      session.dispose()
    }
  }, [session])

  return { ...snapshot, toggle: session.toggle }
}
