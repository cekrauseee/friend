import { code as highlighter, type HighlightResult } from '@streamdown/code'
import { useEffect, useState, type CSSProperties } from 'react'

type CodeLanguage = Parameters<typeof highlighter.supportsLanguage>[0]

interface MarkdownCodeBlockProps {
  source: string
  language: string
  incomplete: boolean
}

export function MarkdownCodeBlock({ source, language, incomplete }: MarkdownCodeBlockProps) {
  const [highlighted, setHighlighted] = useState<{ source: string; language: string; result: HighlightResult } | null>(null)
  const result = highlighted?.source === source && highlighted.language === language ? highlighted.result : null

  useEffect(() => {
    if (!highlighter.supportsLanguage(language as CodeLanguage)) return
    let current = true
    const apply = (result: HighlightResult) => {
      if (current) setHighlighted({ source, language, result })
    }
    try {
      const result = highlighter.highlight({
        code: source, language: language as CodeLanguage,
        isIncomplete: incomplete, themes: highlighter.getThemes(),
      }, apply)
      if (result) apply(result)
    } catch { /* Unknown or incomplete syntax remains readable as plain code. */ }
    return () => { current = false }
  }, [source, language, incomplete])

  return (
    <pre className="markdown-code-block" data-language={language || undefined} dir="ltr"
      tabIndex={0} role="region" aria-label={language ? `${language} code` : 'Code'}>
      <code>{result ? result.tokens.map((line, lineIndex) => (
        <span className="markdown-code-line" key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={{ color: token.color, ...token.htmlStyle } as CSSProperties}>{token.content}</span>
          ))}
          {lineIndex < result.tokens.length - 1 ? '\n' : null}
        </span>
      )) : source}</code>
    </pre>
  )
}
