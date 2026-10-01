import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useAudioCapture } from '@/hooks/use-audio-capture'
import type { CaptureIntent } from '@/lib/audio-capture'

/** Append speech without changing the existing draft's formatting. */
export function appendTranscript(draft: string, transcript: string) {
  const text = transcript.trim()
  return text ? draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text : draft
}

interface DictationOptions {
  draft: string
  enabled: boolean
  onDraftChange: (draft: string) => void
  onSend: (text: string) => string | null
  onOpen: () => void
}

/** Owns draft application separately from capture so canceled results never edit or send. */
export function useComposerDictation({ draft, enabled, onDraftChange, onSend, onOpen }: DictationOptions) {
  const capture = useAudioCapture()
  const cancelCapture = capture.cancel
  const generation = useRef(0)
  const current = useRef({ enabled, status: capture.status })
  const originalDraft = useRef('')
  const finishing = useRef(false)
  const active = capture.status === 'starting' || capture.status === 'recording' || capture.status === 'processing'
  const cancel = useCallback(() => {
    generation.current++
    finishing.current = false
    cancelCapture()
  }, [cancelCapture])

  useLayoutEffect(() => {
    current.current = { enabled, status: capture.status }
  }, [enabled, capture.status])

  useLayoutEffect(() => {
    if (!enabled) cancel()
  }, [enabled, cancel])

  useEffect(() => {
    window.addEventListener('pagehide', cancel)
    return () => { window.removeEventListener('pagehide', cancel); cancel() }
  }, [cancel])

  function start() {
    if (!current.current.enabled || ['starting', 'recording', 'processing'].includes(current.current.status) || finishing.current) return
    generation.current++
    current.current.status = 'starting'
    originalDraft.current = draft
    onOpen()
    void capture.start()
  }

  async function finish(intent: CaptureIntent) {
    if (!current.current.enabled || current.current.status !== 'recording' || finishing.current) return
    finishing.current = true
    const request = generation.current
    const result = await capture.finalize(intent)
    if (request !== generation.current) return
    finishing.current = false
    if (!result) return
    const composed = appendTranscript(originalDraft.current, result.text)
    onDraftChange(composed)
    if (result.intent === 'send' && onSend(composed) !== null) onDraftChange('')
  }

  return { ...capture, active, start, finish, cancel }
}
