import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { Streamdown, defaultComponents, useIsCodeFenceIncomplete, type Components, type ExtraProps, type MermaidErrorComponentProps } from 'streamdown'
import { useReducedMotion } from 'motion/react'
import { Children, isValidElement, useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { MarkdownCodeBlock } from '@/components/markdown-code-block'
import 'streamdown/styles.css'

const plugins = { code, mermaid }

function codeText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement<{ children?: ReactNode }>(child) ? codeText(child.props.children) : ''
  }).join('')
}

function MarkdownCode(props: (ComponentProps<'code'> | Record<string, unknown>) & ExtraProps) {
  const incomplete = useIsCodeFenceIncomplete()
  const children = props.children as ReactNode
  if (!('data-block' in props)) return <code>{children}</code>
  const language = typeof props.className === 'string' ? props.className.match(/language-([^\s]+)/)?.[1] ?? '' : ''
  if (language === 'mermaid') return <defaultComponents.code {...props as ComponentProps<'code'> & ExtraProps} />
  const source = codeText(children).replace(/\n$/, '')
  return <MarkdownCodeBlock source={source} language={language} incomplete={incomplete} />
}

function MarkdownTable({ children }: (ComponentProps<'table'> | Record<string, unknown>) & ExtraProps) {
  return <div className="typeset-scroll" tabIndex={0} role="region" aria-label="Table"><table>{children as ReactNode}</table></div>
}

// Render semantic HTML; Typeset owns prose styling rather than code-block chrome.
const markdownComponents: Components = {
  p: 'p', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  blockquote: 'blockquote', hr: 'hr', ul: 'ul', ol: 'ol', li: 'li', strong: 'strong',
  thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
  table: MarkdownTable, code: MarkdownCode,
}

function MermaidError({ chart, retry }: MermaidErrorComponentProps) {
  return (
    <div className="conversation-diagram-error">
      <p>Could not render this diagram. Its source is below.</p>
      <pre><code>{chart}</code></pre>
      <Button type="button" variant="secondary" onClick={retry}>Retry diagram</Button>
    </div>
  )
}

const mermaidOptions = { errorComponent: MermaidError }
const textAnimation = {
  animation: 'blurIn',
  duration: 200,
  easing: 'ease-out',
  sep: 'word',
  stagger: 30,
  maxBacklogMs: 200,
} as const

// Keep the final tokens mounted until their scheduled entrance has finished.
// Switching to static mode at completion would replace the entire Markdown tree.
function useStreamingAnimation(text: string, streaming: boolean) {
  const [previous, setPrevious] = useState({ text, streaming, settling: false })
  let settling = previous.settling
  if (text !== previous.text || streaming !== previous.streaming) {
    settling = streaming || previous.streaming || previous.settling
    setPrevious({ text, streaming, settling })
  }

  useEffect(() => {
    if (streaming || !settling) return
    const timer = setTimeout(() => {
      setPrevious((state) => ({ ...state, settling: false }))
    }, textAnimation.maxBacklogMs + textAnimation.duration)
    return () => clearTimeout(timer)
  }, [text, streaming, settling])

  return streaming || settling
}

interface AssistantMarkdownProps {
  text: string
  streaming: boolean
}

export function AssistantMarkdown({ text, streaming }: AssistantMarkdownProps) {
  const reducedMotion = useReducedMotion()
  const animating = useStreamingAnimation(text, streaming)

  return (
    <Streamdown
      className="typeset conversation-markdown"
      mode="streaming"
      parseIncompleteMarkdown={animating}
      plugins={plugins}
      components={markdownComponents}
      controls={false}
      mermaid={mermaidOptions}
      animated={reducedMotion ? false : textAnimation}
      isAnimating={animating}
      skipHtml
      disallowedElements={['img']}
      dir="auto"
    >
      {text}
    </Streamdown>
  )
}
