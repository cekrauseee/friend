import { decodeString } from 'micromark-util-decode-string'
import type { ElementContent } from 'hast'
import type { Root, RootContent } from 'mdast'

export interface MarkdownDelta {
  id: string
  start: number
  end: number
  startedAt: number
}

export const deltaEntrance = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  keyframes: [{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0px)' }],
} as const

export function animateDelta(element: Pick<HTMLElement, 'animate'> | null, startedAt: number, reducedMotion: boolean, now = performance.now()) {
  const elapsed = Math.max(0, now - startedAt)
  if (!element?.animate || reducedMotion || elapsed >= deltaEntrance.duration) return
  const animation = element.animate([...deltaEntrance.keyframes], {
    duration: deltaEntrance.duration, easing: deltaEntrance.easing,
  })
  animation.currentTime = elapsed
  return () => animation.cancel()
}

export interface DeltaTextPart {
  text: string
  offset: number
  delta?: MarkdownDelta
}

// Map decoded text back to source offsets. Escapes, entities and graphemes
// belong to the delta that completes them, never to individual words.
export function splitDeltaText(value: string, raw: string, start: number, deltas: readonly MarkdownDelta[], decode = true): DeltaTextPart[] {
  if (!value || !deltas.length) return [{ text: value, offset: 0 }]
  const offsets: number[] = []
  const units = decode
    ? /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);|\r\n|[^]/gu
    : /\r\n|[^]/gu
  let cursor = 0
  for (const match of raw.matchAll(units)) {
    const decoded = (decode ? decodeString(match[0]) : match[0]).replace(/\r\n/g, '\n')
    if (!value.startsWith(decoded, cursor)) continue
    for (let index = 0; index < decoded.length; index++) offsets[cursor++] = start + match.index + match[0].length - 1
  }
  // Markdown can normalize whitespace (notably inside inline code).
  // Keep unmatched text readable and use its enclosing source position.
  while (offsets.length < value.length) offsets.push(start + raw.length - 1)
  const parts: DeltaTextPart[] = []
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let low = 0
  let high = deltas.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (deltas[middle].end <= start) low = middle + 1
    else high = middle
  }
  let deltaIndex = low
  for (const { segment, index } of graphemes.segment(value)) {
    const offset = offsets[index + segment.length - 1]
    while (deltaIndex < deltas.length && deltas[deltaIndex].end <= offset) deltaIndex++
    const candidate = deltas[deltaIndex]
    const delta = candidate && candidate.start <= offset && offset < candidate.end ? candidate : undefined
    const last = parts.at(-1)
    if (last && last.delta?.id === delta?.id) last.text += segment
    else parts.push({ text: segment, offset: index, delta })
  }
  return parts
}

function toChildren(parts: DeltaTextPart[]): ElementContent[] {
  return parts.map(({ text, delta }) => delta ? {
    type: 'element', tagName: 'span',
    properties: { 'data-markdown-delta': delta.id, 'data-delta-started-at': delta.startedAt },
    children: [{ type: 'text', value: text }],
  } : { type: 'text', value: text })
}

export function remarkDeltaText({ source, deltas }: { source: string; deltas: readonly MarkdownDelta[] }) {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if ((node.type === 'text' || node.type === 'inlineCode') && node.position) {
        let start = node.position.start.offset ?? 0
        const end = node.position.end.offset ?? start
        let raw = source.slice(start, end)
        if (node.type === 'inlineCode') {
          const marker = raw.match(/^`+/)?.[0] ?? ''
          start += marker.length
          raw = raw.slice(marker.length, -marker.length)
          raw = raw.replace(/\r?\n/g, ' ')
        }
        const children = toChildren(splitDeltaText(node.value, raw, start, deltas, node.type === 'text'))
        if (children.some((child) => child.type === 'element')) {
          node.data = { ...node.data, hName: node.type === 'inlineCode' ? 'code' : 'span', hChildren: children }
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

export function codeSource(raw: string, start: number) {
  const opening = raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/)
  if (!opening) return { raw, start, closed: true }
  const body = raw.slice(opening[0].length)
  const marker = opening[1][0]
  const closing = new RegExp(`(?:^|\\n) {0,3}${marker}{${opening[1].length},}[ \\t]*$`)
  return { raw: body.replace(closing, ''), start: start + opening[0].length, closed: closing.test(body) }
}
