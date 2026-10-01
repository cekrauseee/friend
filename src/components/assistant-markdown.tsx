import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Children, createContext, isValidElement, useContext, type ComponentProps, type ReactNode } from 'react'
import { MarkdownCodeBlock } from '@/components/markdown-code-block'
import { MarkdownDelta } from '@/components/markdown-delta'
import { MarkdownDiagram } from '@/components/markdown-diagram'
import { codeSource, remarkDeltaText, type MarkdownDelta as Delta } from '@/lib/markdown-deltas'

const emptyDeltas: readonly Delta[] = []
const MarkdownContext = createContext({ text: '', streaming: false, deltas: emptyDeltas })

function codeText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement<{ children?: ReactNode }>(child) ? codeText(child.props.children) : ''
  }).join('')
}

function MarkdownPre({ node, children }: ComponentProps<'pre'> & ExtraProps) {
  const { text, streaming, deltas } = useContext(MarkdownContext)
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  // Display math is transformed by rehype-katex, rather than a code block.
  if (!code || code.type !== 'element') return <pre>{children}</pre>
  const classes = code.properties.className
  const language = Array.isArray(classes) ? String(classes.find((name) => String(name).startsWith('language-')) ?? '').slice(9) : ''
  const source = codeText(children).replace(/\n$/, '')
  const start = node?.position?.start.offset ?? 0
  const raw = text.slice(start, node?.position?.end.offset ?? start)
  const content = codeSource(raw, start)
  const block = <MarkdownCodeBlock source={source} language={language} raw={content.raw} start={content.start} deltas={deltas} />
  return language === 'mermaid' && (content.closed || !streaming)
    ? <MarkdownDiagram source={source} fallback={block} /> : block
}

function MarkdownTable({ children }: ComponentProps<'table'>) {
  return <div className="typeset-scroll" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>
}

function MarkdownSpan({ node, children, ...props }: ComponentProps<'span'> & ExtraProps) {
  const id = node?.properties['data-markdown-delta']
  const startedAt = node?.properties['data-delta-started-at']
  return typeof id === 'string' && typeof startedAt === 'number'
    ? <MarkdownDelta id={id} startedAt={startedAt}>{children}</MarkdownDelta>
    : <span {...props}>{children}</span>
}

// Semantic content stays unstyled. Typeset owns all prose and code typography.
const components: Components = { pre: MarkdownPre, table: MarkdownTable, span: MarkdownSpan }

interface AssistantMarkdownProps {
  text: string
  streaming: boolean
  deltas?: readonly Delta[]
}

export function AssistantMarkdown({ text, streaming, deltas = emptyDeltas }: AssistantMarkdownProps) {
  return (
    <div className="typeset typeset-docs max-w-[33em] conversation-markdown" dir="auto">
      <MarkdownContext.Provider value={{ text, streaming, deltas }}>
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath, [remarkDeltaText, { source: text, deltas }]]}
          rehypePlugins={[rehypeKatex]}
          components={components}
          skipHtml
          disallowedElements={['img']}
        >
          {text}
        </Markdown>
      </MarkdownContext.Provider>
    </div>
  )
}
