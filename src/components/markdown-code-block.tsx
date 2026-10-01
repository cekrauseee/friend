import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { TokensResult } from 'shiki'
import { MarkdownDelta } from '@/components/markdown-delta'
import { splitDeltaText, type MarkdownDelta as Delta } from '@/lib/markdown-deltas'

interface MarkdownCodeBlockProps {
  source: string
  language: string
  raw: string
  start: number
  deltas: readonly Delta[]
}

export function MarkdownCodeBlock({ source, language, raw, start, deltas }: MarkdownCodeBlockProps) {
  const [highlighted, setHighlighted] = useState<{ source: string; language: string; result: TokensResult } | null>(null)
  const result = highlighted?.language === language && source.startsWith(highlighted.source) ? highlighted.result : null

  useEffect(() => {
    if (!language || language === 'mermaid') return
    let current = true
    void import('shiki').then(async ({ codeToTokens, bundledLanguages }) => {
      if (!(language in bundledLanguages)) return
      const result = await codeToTokens(source, {
        lang: language as keyof typeof bundledLanguages,
        themes: { light: 'github-light', dark: 'github-dark' },
      })
      if (current) setHighlighted({ source, language, result })
    }).catch(() => { /* Unknown or incomplete syntax stays readable as plain code. */ })
    return () => { current = false }
  }, [source, language])

  const tokens = result?.tokens.flat() ?? []
  const parts = splitDeltaText(source, raw, start, deltas, false)
  const content = parts.map((part) => {
    let children: ReactNode = part.text
    if (result) {
      const end = part.offset + part.text.length
      let cursor = part.offset
      const fragments: ReactNode[] = []
      for (const token of tokens) {
        const from = Math.max(part.offset, token.offset)
        const to = Math.min(end, token.offset + token.content.length)
        if (to <= from) continue
        if (from > cursor) fragments.push(source.slice(cursor, from))
        fragments.push(<span key={from} data-syntax-token style={{ color: token.color, ...token.htmlStyle } as CSSProperties}>{source.slice(from, to)}</span>)
        cursor = to
      }
      if (cursor < end) fragments.push(source.slice(cursor, end))
      children = fragments
    }
    return part.delta
      ? <MarkdownDelta key={`${part.delta.id}:${part.offset}`} id={part.delta.id} startedAt={part.delta.startedAt}>{children}</MarkdownDelta>
      : <span key={part.offset}>{children}</span>
  })

  return (
    <pre data-language={language || undefined} dir="ltr" tabIndex={0} role="region" aria-label={language ? `${language} code` : 'Code'}>
      <code>{content}</code>
    </pre>
  )
}
