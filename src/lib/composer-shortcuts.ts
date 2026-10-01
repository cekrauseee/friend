export type ComposerKeyAction = 'insert' | 'select-all' | 'paste' | 'delete-word' | 'delete-line' | 'composition' | null

export function composerKeyAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented'> & { altGraph?: boolean }): ComposerKeyAction {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.altGraph) return [...event.key].length === 1 ? 'insert' : null
  if (event.altKey) return null
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'a') return 'select-all'
    if (event.key.toLowerCase() === 'v') return 'paste'
    if (event.key === 'Backspace') return event.metaKey ? 'delete-line' : 'delete-word'
    return null
  }
  if (event.key === 'Dead' || event.key === 'Process') return 'composition'
  return [...event.key].length === 1 ? 'insert' : null
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

export function composerEdit(value: string, start: number, end: number, action: 'insert' | 'delete-word' | 'delete-line', text = '') {
  if (start === end && action === 'delete-line') start = start > 0 ? value.lastIndexOf('\n', start - 1) + 1 : 0
  if (start === end && action === 'delete-word') {
    const prefix = value.slice(0, start)
    start = [...words.segment(prefix)].findLast((segment) => segment.isWordLike)?.index ?? 0
  }
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length }
}
