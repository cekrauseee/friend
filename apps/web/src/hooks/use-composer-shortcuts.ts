import { useEffect, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { composerEdit, composerKeyAction } from '@/lib/composer-shortcuts'
import { interfaceSounds } from '@/lib/interface-sounds'

interface ComposerShortcutsOptions {
  enabled: boolean
  open: boolean
  inputRef: RefObject<HTMLTextAreaElement | null>
  onOpen: () => void
  onDraftChange: (draft: string) => void
}

export function useComposerShortcuts({ enabled, open, inputRef, onOpen, onDraftChange }: ComposerShortcutsOptions) {
  useEffect(() => {
    if (!enabled) return
    const blocked = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null
      return Boolean(document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
        || inputRef.current?.closest('[data-calling="true"]')
        || element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], [data-appearance-control]'))
    }
    const focus = () => {
      if (!open) flushSync(onOpen)
      const input = inputRef.current
      input?.focus({ preventScroll: true })
      return input
    }
    const edit = (input: HTMLTextAreaElement, action: 'insert' | 'delete-word' | 'delete-line', text = '') => {
      const previous = input.value
      const next = composerEdit(input.value, input.selectionStart, input.selectionEnd, action, text)
      flushSync(() => onDraftChange(next.value))
      input.setSelectionRange(next.caret, next.caret)
      if (next.value !== previous) interfaceSounds.play('composerTyping', true)
    }
    const keydown = (event: KeyboardEvent) => {
      if (blocked(event.target)) return
      const action = composerKeyAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        altKey: event.altKey, isComposing: event.isComposing, defaultPrevented: event.defaultPrevented,
        altGraph: event.getModifierState('AltGraph') })
      if (!action) return
      if (action === 'insert' && event.key === ' ' && event.target instanceof Element
        && event.target.closest('button, a, [role="button"]')) return
      const input = focus()
      if (!input) return
      if (action === 'paste' || action === 'composition') return // Keep trusted browser paste and IME handling.
      event.preventDefault()
      if (action === 'select-all') input.select()
      else edit(input, action, action === 'insert' ? event.key : '')
    }
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || blocked(event.target)) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      const input = focus()
      if (!input) return
      event.preventDefault()
      edit(input, 'insert', text)
    }
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('paste', paste, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('paste', paste, true)
    }
  }, [enabled, open, inputRef, onOpen, onDraftChange])
}
