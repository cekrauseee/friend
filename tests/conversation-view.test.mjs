import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const modules = new Map()
async function componentModule(url) {
  if (modules.has(url.href)) return modules.get(url.href)
  let source
  try { source = await readFile(url, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT' || !url.pathname.endsWith('.tsx')) throw error
    return componentModule(new URL(url.href.replace(/\.tsx$/, '.ts')))
  }
  let code = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import ['"]streamdown\/styles.css['"];?$/m, '')
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = name.startsWith('@/')
      ? await componentModule(new URL(`src/${name.slice(2)}.tsx`, root))
      : name.startsWith('.') ? await componentModule(new URL(name, url)) : import.meta.resolve(name)
    code = code.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`)
      .replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  const data = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  modules.set(url.href, data)
  return data
}
const { TextConversationView } = await import(await componentModule(new URL('src/components/text-conversation-view.tsx', root)))
const { SoundToggle } = await import(await componentModule(new URL('src/components/sound-toggle.tsx', root)))
const base = {
  ready: true, turns: [], activeTurnId: null,
  onSend: () => null, onRetry: () => false, onToggleCall: () => {},
  voiceStatus: 'idle', voiceError: null, inputBands: [], outputLevel: 0,
}
const render = (props = {}) => renderToStaticMarkup(createElement(TextConversationView, { ...base, ...props }))

test('idle renders chat and call with the same preset button size', () => {
  const html = render()
  assert.match(html, /unified-orb-stage/)
  assert.match(html, /class="conversation-footer" data-idle="true"/)
  assert.match(html, /aria-label="Open text chat"/)
  assert.match(html, /aria-label="Start call"/)
  assert.equal([...html.matchAll(/data-size="icon-lg"/g)].length, 2)
})

test('call phases hide chat from interaction and accessibility while preserving the call action', () => {
  for (const [voiceStatus, label] of [['connecting', 'Cancel call'], ['connected', 'End call'], ['closing', 'Ending call']]) {
    const html = render({ voiceStatus })
    assert.match(html, /class="conversation-composer-send" inert="" aria-hidden="true"/)
    assert.match(html, new RegExp(`aria-label="${label}"`))
    assert.match(html, /unified-voice-feedback/)
    const rowStyle = html.match(/class="conversation-composer-row"[^>]*style="([^"]+)"/)?.[1]
    assert.ok(rowStyle)
    assert.match(rowStyle, /height:36px/)
    assert.doesNotMatch(html, /translateY\(-2px\)/)
  }
})

test('existing messages omit the large orb and render an open composer immediately', () => {
  const html = render({ turns: [{ id: 'one', userText: 'Hello', assistantText: 'Hi', status: 'complete', error: null }] })
  assert.doesNotMatch(html, /unified-orb-stage/)
  assert.match(html, /class="conversation-footer" data-idle="false"/)
  assert.match(html, /data-open="true"/)
  assert.match(html, /aria-label="Send message"/)
  assert.match(html, /placeholder="Ask anything"/)
  assert.match(html, /data-slot="message-scroller-viewport"/)
  assert.match(html, /role="region"/)
  assert.match(html, /role="log"/)
  assert.match(html, /data-message-id="one" data-scroll-anchor="false"/)
  assert.match(html, /data-message-scroller-spacer/)
  assert.doesNotMatch(html, /data-conversation-spacer/)
  const bubbleStyle = html.match(/class="conversation-user-row" style="([^"]+)"/)?.[1]
  assert.ok(bubbleStyle)
  assert.match(bubbleStyle, /opacity:1/)
  assert.doesNotMatch(bubbleStyle, /translateY\(8px\)|scale\(0\.96\)/)
})

test('only the newly sent bubble starts offset and scaled; history remains settled', () => {
  const html = render({ turns: [
    { id: 'old', userText: 'Earlier', assistantText: 'Done', status: 'complete', error: null },
    { id: 'new', userText: 'Hello', assistantText: '', status: 'waiting', error: null },
  ], activeTurnId: 'new' })
  const styles = [...html.matchAll(/class="conversation-user-row" style="([^"]+)"/g)].map((match) => match[1])
  assert.equal(styles.length, 2)
  assert.match(styles[0], /opacity:1/)
  assert.doesNotMatch(styles[0], /translateY\(8px\)|scale\(0\.96\)/)
  assert.match(styles[1], /opacity:0/)
  assert.match(styles[1], /translateY\(8px\) scale\(0\.96\)/)
})

test('streaming transcript exposes busy state and the scroller owns the jump control', () => {
  const html = render({ turns: [{ id: 'one', userText: 'Hello', assistantText: 'Hi', status: 'streaming', error: null }], activeTurnId: 'one' })
  assert.match(html, /data-conversation-content[^>]*aria-busy="true"/)
  assert.match(html, /data-slot="message-scroller-button"/)
  assert.match(html, /aria-label="Jump to latest message"/)
  const reply = html.indexOf('data-assistant-reply="one"')
  const orb = html.indexOf('class="conversation-compact-orb"')
  assert.ok(orb > reply)
  assert.equal([...html.matchAll(/class="conversation-compact-orb"/g)].length, 1)
  assert.doesNotMatch(html, /conversation-orb-home/)
  assert.match(html, /conversation-orb-anchor/)
})

test('sound preference renders a named native toggle with an accessible pressed state', () => {
  const html = renderToStaticMarkup(createElement(SoundToggle))
  assert.match(html, /^<button/)
  assert.match(html, /aria-label="Interface sounds"/)
  assert.match(html, /aria-pressed="false"/)
  assert.match(html, /title="Enable interface sounds"/)
})

test('active calls place the waveform before the call action inside the same composer', () => {
  const html = render({ voiceStatus: 'connected' })
  const call = html.indexOf('class="conversation-composer-call"')
  const waveform = html.indexOf('class="unified-voice-feedback"')
  const formEnd = html.indexOf('</form>')
  assert.ok(waveform > 0 && call > waveform && formEnd > call)
})
