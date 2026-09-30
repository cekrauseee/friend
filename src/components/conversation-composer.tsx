import { useId, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUpIcon, PhoneIcon } from 'lucide-react'

interface ConversationComposerProps {
  draft: string
  onDraftChange: (draft: string) => void
  onSubmit: () => void
  onEnterVoice: () => void
  busy: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
}

export function ConversationComposer({
  draft,
  onDraftChange,
  onSubmit,
  onEnterVoice,
  busy,
  inputRef,
}: ConversationComposerProps) {
  const labelId = useId()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    onSubmit()
  }

  return (
    <form className="conversation-composer" onSubmit={submit}>
      <label id={labelId} htmlFor={`${labelId}-input`} className="sr-only">Message</label>
      <textarea
        ref={inputRef}
        id={`${labelId}-input`}
        name="message"
        rows={2}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Friend"
        aria-labelledby={labelId}
      />
      <div className="conversation-composer-actions">
        <button type="submit" className="conversation-icon-button conversation-send" aria-label="Send message" disabled={busy}>
          <ArrowUpIcon aria-hidden="true" />
        </button>
        <button type="button" className="conversation-icon-button conversation-call" aria-label="Start voice call" onClick={onEnterVoice}>
          <PhoneIcon aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}
