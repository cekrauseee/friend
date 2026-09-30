import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Exercise the actual TSX component without adding a separate test bundler.
async function loadComponent(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import ['"]streamdown\/styles.css['"];?$/m, '')
  for (const name of new Set([...compiled.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = name.startsWith('@/')
      ? await loadComponent(`../src/${name.slice(2)}.tsx`)
      : import.meta.resolve(name)
    compiled = compiled.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`)
      .replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
}
const { AssistantMarkdown } = await import(await loadComponent('../src/components/assistant-markdown.tsx'))

const render = (text, streaming) => renderToStaticMarkup(createElement(AssistantMarkdown, { text, streaming }))

test('streamed words and rich text use one blur-in entrance per word', () => {
  const html = render('Hello **there** dot', true)
  const spans = [...html.matchAll(/<span data-sd-animate="true" style="([^"]+)">([^<]*)<\/span>/g)]
  assert.equal(spans.length, 3)
  assert.deepEqual(spans.map(([, , text]) => text.trim()), ['Hello', 'there', 'dot'])
  for (const [, style] of spans) {
    assert.match(style, /--sd-animation:sd-blurIn/)
    assert.match(style, /--sd-duration:200ms/)
  }
  assert.match(html, /<strong(?:\s|>)/)
})

test('existing completed answers render Markdown without entrance animations', () => {
  const html = render('A **finished** answer.', false)
  assert.doesNotMatch(html, /data-sd-animate/)
  assert.match(html, /<strong>finished<\/strong>/)
  assert.match(html, /answer\./)
})

test('prose renders semantic headings, quotes, rules and lists instead of code containers', () => {
  const html = render('# Heading\n\nA **bold** and _emphasized_ paragraph.\n\n> A quotation.\n\n---\n\n- First\n- Second\n\n1. Ordered\n2. Items', false)
  for (const tag of ['h1', 'p', 'strong', 'em', 'blockquote', 'hr', 'ul', 'ol', 'li']) assert.match(html, new RegExp(`<${tag}(?:>|\\s|/)`))
  assert.match(html, /typeset conversation-markdown/)
  assert.doesNotMatch(html, /markdown-code-block|code-block-actions|<pre/)
})

test('inline code stays in the paragraph and fenced code uses a single simple container', () => {
  const html = render('Run `npm test`.\n\n```js\nconst message = "<tag>";\n```', false)
  assert.match(html, /<p>Run <code>npm test<\/code>\.<\/p>/)
  assert.equal([...html.matchAll(/<pre\b/g)].length, 1)
  assert.match(html, /class="markdown-code-block" data-language="js"/)
  assert.match(html, /const message = &quot;&lt;tag&gt;&quot;;/)
  assert.doesNotMatch(html, /<button|code-block-header|code-block-actions|Download|Maximize/)
})

test('plain and unknown-language fences remain readable and never fall back to prose', () => {
  for (const language of ['', 'unknown-language']) {
    const html = render(`\`\`\`${language}\n  indentation\nsecond line\n\`\`\``, false)
    assert.match(html, /markdown-code-block/)
    assert.match(html, /<code>  indentation\nsecond line<\/code>/)
  }
})

test('incomplete code streams keep their text without requiring a closing fence', () => {
  const html = render('Before.\n\n```js\nconst value =', true)
  assert.match(html, /markdown-code-block/)
  assert.match(html, /const value =/)
  assert.doesNotMatch(html, /<button/)
})

test('GFM tables retain real table semantics without toolbar or file actions', () => {
  const html = render('| Item | Value |\n| --- | ---: |\n| Example | 12 |', false)
  for (const tag of ['table', 'thead', 'tbody', 'th', 'td']) assert.match(html, new RegExp(`<${tag}(?:>|\\s)`))
  assert.match(html, /typeset-scroll/)
  assert.doesNotMatch(html, /<button|table-wrapper|Download|Maximize/)
})
