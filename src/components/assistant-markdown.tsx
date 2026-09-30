import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { Streamdown, type MermaidErrorComponentProps } from 'streamdown'
import { useReducedMotion } from 'motion/react'
import 'streamdown/styles.css'

const plugins = { code, mermaid }

function MermaidError({ chart, retry }: MermaidErrorComponentProps) {
  return (
    <div className="conversation-diagram-error">
      <p>Could not render this diagram. Its source is below.</p>
      <pre><code>{chart}</code></pre>
      <button type="button" onClick={retry}>Retry diagram</button>
    </div>
  )
}

const mermaidOptions = { errorComponent: MermaidError }

interface AssistantMarkdownProps {
  text: string
  streaming: boolean
}

export function AssistantMarkdown({ text, streaming }: AssistantMarkdownProps) {
  const reducedMotion = useReducedMotion()
  const animateWords = streaming && !reducedMotion

  return (
    <Streamdown
      className="conversation-markdown"
      mode={streaming ? 'streaming' : 'static'}
      plugins={plugins}
      mermaid={mermaidOptions}
      animated={animateWords ? { animation: 'blurIn' } : false}
      isAnimating={animateWords}
      skipHtml
      disallowedElements={['img']}
      dir="auto"
    >
      {text}
    </Streamdown>
  )
}
