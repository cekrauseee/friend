import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

// Keep generated SVG outside prose styling. Mermaid sanitizes it in strict mode;
// the raw Markdown is never treated as HTML.
export function MarkdownDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const id = useId().replace(/:/g, '')
  const ref = useRef<HTMLDivElement>(null)
  const [renderedSource, setRenderedSource] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    const container = ref.current
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral' })
      const { svg } = await mermaid.render(`markdown-diagram-${id}`, source)
      if (!current || !container) return
      container.innerHTML = svg
      setRenderedSource(source)
    }).catch(() => { /* Invalid diagrams retain their readable source. */ })
    return () => { current = false }
  }, [id, source])

  const visible = renderedSource === source
  return (
    <div className="markdown-diagram">
      <div className="not-typeset" ref={ref} hidden={!visible} role="img" aria-label="Mermaid diagram" />
      {visible ? null : fallback}
    </div>
  )
}
