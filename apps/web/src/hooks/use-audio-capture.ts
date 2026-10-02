import { useEffect, useState, useSyncExternalStore } from 'react'
import { AudioCapture } from '@/lib/audio-capture'

/** Keeps recording resources outside the composer and closes them on every page exit. */
export function useAudioCapture() {
  const [capture] = useState(() => new AudioCapture())
  const snapshot = useSyncExternalStore(capture.subscribe, capture.getSnapshot)

  useEffect(() => {
    window.addEventListener('pagehide', capture.dispose)
    return () => {
      window.removeEventListener('pagehide', capture.dispose)
      capture.dispose()
    }
  }, [capture])

  return { ...snapshot, start: capture.start, finalize: capture.finalize, cancel: capture.cancel }
}
