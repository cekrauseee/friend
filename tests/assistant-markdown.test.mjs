import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

// Exercise the actual TSX component without adding a separate test bundler.
async function loadComponent(path) {
  let source
  try { source = await readFile(new URL(path, import.meta.url), 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT' || !path.endsWith('.tsx')) throw error
    return loadComponent(path.replace(/\.tsx$/, '.ts'))
  }
  let compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  }).outputText
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

const render = (text, streaming, deltas) => renderToStaticMarkup(createElement(AssistantMarkdown, { text, streaming, deltas }))

test('one multiword delta gets one entrance group, without word splitting or staggering', () => {
  const text = 'Hello there dot'
  const html = render(text, true, [{ id: 'first', start: 0, end: text.length, startedAt: 10 }])
  assert.equal([...html.matchAll(/data-markdown-delta="first"/g)].length, 1)
  assert.match(html, /<span data-markdown-delta="first">Hello there dot<\/span>/)
  assert.doesNotMatch(html, /animation-delay|stagger|data-sd-/)
})

test('existing completed answers render Markdown without entrance animations', () => {
  const html = render('A **finished** answer.', false)
  assert.doesNotMatch(html, /data-markdown-delta/)
  assert.match(html, /<strong>finished<\/strong>/)
  assert.match(html, /answer\./)
})

test('prose renders semantic headings, quotes, rules and lists instead of code containers', () => {
  const html = render('# Heading\n\nA **bold** and _emphasized_ paragraph.\n\n> A quotation.\n\n---\n\n- First\n- Second\n\n1. Ordered\n2. Items', false)
  for (const tag of ['h1', 'p', 'strong', 'em', 'blockquote', 'hr', 'ul', 'ol', 'li']) assert.match(html, new RegExp(`<${tag}(?:>|\\s|/)`))
  assert.match(html, /typeset typeset-docs max-w-\[33em\]/)
  assert.doesNotMatch(html, /code-block-actions|<pre/)
})

test('inline code stays in the paragraph and fenced code uses a single simple container', () => {
  const html = render('Run `npm test`.\n\n```js\nconst message = "<tag>";\n```', false)
  assert.match(html, /<p>Run <code>npm test<\/code>\.<\/p>/)
  assert.equal([...html.matchAll(/<pre\b/g)].length, 1)
  assert.match(html, /<pre data-language="js"/)
  assert.match(html, /const message = &quot;&lt;tag&gt;&quot;;/)
  assert.doesNotMatch(html, /<button|code-block-header|code-block-actions|Download|Maximize/)
})

test('plain and unknown-language fences remain readable and never fall back to prose', () => {
  for (const language of ['', 'unknown-language']) {
    const html = render(`\`\`\`${language}\n  indentation\nsecond line\n\`\`\``, false)
    assert.match(html, /<pre(?:\s|>)/)
    assert.match(html, /<code><span>  indentation\nsecond line<\/span><\/code>/)
  }
})

test('incomplete code streams keep their text without requiring a closing fence', () => {
  const html = render('Before.\n\n```js\nconst value =', true)
  assert.match(html, /<pre data-language="js"/)
  assert.match(html, /const value =/)
  assert.doesNotMatch(html, /<button/)
})

test('GFM tables retain real table semantics without toolbar or file actions', () => {
  const html = render('| Item | Value |\n| --- | ---: |\n| Example | 12 |', false)
  for (const tag of ['table', 'thead', 'tbody', 'th', 'td']) assert.match(html, new RegExp(`<${tag}(?:>|\\s)`))
  assert.match(html, /typeset-scroll/)
  assert.doesNotMatch(html, /<button|table-wrapper|Download|Maximize/)
})

test('a delta crossing formatting and blocks keeps one shared entrance identity', () => {
  const text = 'Hello **there** friend.\n\n- One item\n- Two items'
  const html = render(text, true, [{ id: 'network-1', start: 0, end: text.length, startedAt: 10 }])
  const ids = [...html.matchAll(/data-markdown-delta="([^"]+)"/g)].map(([, id]) => id)
  assert.ok(ids.length > 2)
  assert.deepEqual([...new Set(ids)], ['network-1'])
  assert.match(html, /<strong><span(?:\s|>)/)
  assert.match(html, /<li><span(?:\s|>)/)
})

test('batched updates preserve both network deltas rather than merging their entrances', () => {
  const text = 'Hello there, friend'
  const deltas = [
    { id: 'one', start: 0, end: 11, startedAt: 10 },
    { id: 'two', start: 11, end: text.length, startedAt: 10 },
  ]
  const html = render(text, true, deltas)
  assert.match(html, /data-markdown-delta="one">Hello there<\/span>/)
  assert.match(html, /data-markdown-delta="two">, friend<\/span>/)
  assert.equal(render(text, false, deltas), html, 'completion preserves the rendered tree for the final entrance')
})

test('fenced code animates by source deltas without splitting words or syntax tokens', () => {
  const text = '```js\nconst value = 123;\n```'
  const html = render(text, true, [{ id: 'code', start: 0, end: text.length, startedAt: 10 }])
  assert.equal([...html.matchAll(/data-markdown-delta="code"/g)].length, 1)
  assert.match(html, /data-markdown-delta="code">const value = 123;<\/span>/)
})

test('inline and display math render KaTeX and retain accessible MathML', () => {
  const html = render('Inline $x^2$.\n\n$$\n\\frac{1}{2}\n$$', false)
  assert.match(html, /class="katex"/)
  assert.match(html, /class="katex-display"/)
  assert.match(html, /<math(?:\s|>)/)
  assert.doesNotMatch(html, /data-language="math"/)
})

test('Markdown cannot inject raw HTML, unsafe links, or remote images', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n![image](https://example.com/image.png)', false)
  assert.doesNotMatch(html, /<script|<img|onerror|href="javascript:/)
})

test('incomplete diagrams remain code until the fence closes', () => {
  const html = render('```mermaid\ngraph TD\n  A --> B', true)
  assert.match(html, /data-language="mermaid"/)
  assert.doesNotMatch(html, /markdown-diagram/)
  const complete = render('```mermaid\ngraph TD\n  A --> B\n```', false)
  assert.match(complete, /class="markdown-diagram"/)
  assert.match(complete, /class="not-typeset"/)
  assert.match(complete, /data-language="mermaid"/, 'source remains readable while the diagram is loading')
})
