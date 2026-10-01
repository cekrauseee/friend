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
  if (url.pathname.endsWith('/hooks/use-audio-capture.tsx')) return `data:text/javascript;base64,${Buffer.from('export const useAudioCapture = () => globalThis.__viewCapture ?? ({ status: "idle", error: null, inputBands: [], start: async () => {}, finalize: async () => null, cancel: () => {} });').toString('base64')}`
  let source
  try { source = await readFile(url, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT' || !url.pathname.endsWith('.tsx')) throw error
    return componentModule(new URL(url.href.replace(/\.tsx$/, '.ts')))
  }
  let code = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
  }).outputText
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

test('idle renders chat, microphone and call with the same preset button size', () => {
  const html = render()
  assert.match(html, /unified-orb-stage/)
  assert.match(html, /class="conversation-footer" data-idle="true"/)
  assert.match(html, /aria-label="Open text chat"/)
  assert.match(html, /aria-label="Start call"/)
  assert.match(html, /aria-label="Start recording"/)
  assert.ok(html.indexOf('aria-label="Open text chat"') < html.indexOf('aria-label="Start recording"'))
  assert.ok(html.indexOf('aria-label="Start recording"') < html.indexOf('aria-label="Start call"'))
  assert.equal([...html.matchAll(/data-size="icon-lg"/g)].length, 3)
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
  assert.doesNotMatch(html, /aria-label="Start call"/)
  assert.match(html, /aria-label="Start recording"/)
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

const { ConversationComposer } = await import(await componentModule(new URL('src/components/conversation-composer.tsx', root)))
const capture = { status: 'idle', error: null, inputBands: [], active: false, start() {}, async finish() {}, cancel() {} }
const renderComposer = (dictation) => renderToStaticMarkup(createElement(ConversationComposer, {
  draft: 'Existing draft', onDraftChange() {}, onSubmit() {}, onToggleCall() {}, showCall: true,
  voiceStatus: 'idle', inputBands: [], hasVoiceError: false, open: true, onOpen() {}, onClose() {}, busy: false,
  inputRef: { current: null }, dictation: { ...capture, ...dictation },
}))

test('recording replaces editable draft with reactive waveform and three named actions', () => {
  const html = renderComposer({ status: 'recording', active: true, inputBands: Array(32).fill(0.4) })
  assert.match(html, /class="conversation-composer-field-wrap" inert="" aria-hidden="true"/)
  assert.match(html, /aria-label="Cancel recording"/)
  assert.match(html, /aria-label="Stop recording and insert transcript"/)
  assert.match(html, /aria-label="Accept recording and send message"/)
  assert.match(html, /class="conversation-dictation-feedback"/)
  assert.doesNotMatch(html, /aria-label="Start call"|aria-label="Start recording"/)
  assert.ok(html.indexOf('aria-label="Cancel recording"') < html.indexOf('class="conversation-dictation-feedback"'))
  assert.ok(html.indexOf('class="conversation-dictation-feedback"') < html.indexOf('aria-label="Stop recording'))
})

test('starting and processing keep cancellation available and prevent another finishing action', () => {
  for (const status of ['starting', 'processing']) {
    const html = renderComposer({ status, active: true })
    assert.match(html, /aria-label="Cancel recording"[^>]*>/)
    assert.match(html, /aria-label="Stop recording and insert transcript"[^>]*disabled=""/)
    assert.match(html, /aria-label="Accept recording and send message"[^>]*disabled=""/)
    assert.match(html, /data-slot="live-waveform" data-processing="true"/)
    assert.doesNotMatch(html, /Starting recording|Transcribing|data-slot="spinner"/)
  }
})

test('call checks leave the composer in place and disable competing recording while remaining cancelable', () => {
  const html = render({ voiceStatus: 'checking' })
  assert.match(html, /data-calling="false"/)
  assert.match(html, /aria-label="Cancel call check"/)
  assert.match(html, /aria-label="Start recording"[^>]*aria-disabled="true"/)
  assert.doesNotMatch(html, /aria-label="Start recording"[^>]*\sdisabled=""/)
  assert.doesNotMatch(html, /data-slot="spinner"|call-check/)
  assert.match(html, /data-slot="live-waveform"/)
  assert.match(html, /class="unified-voice-feedback"[^>]*style="[^"]*width:0/)
})

test('call preflight keeps the idle button variant, dimensions and icons', async () => {
  const { CallButton } = await import(await componentModule(new URL('src/components/call-button.tsx', root)))
  const button = status => renderToStaticMarkup(createElement(CallButton, { status, hasError: false, onClick() {} }))
  const idle = button('idle'), checking = button('checking')
  assert.equal(idle.match(/class="([^"]+)"/)[1], checking.match(/class="([^"]+)"/)[1])
  assert.equal(idle.match(/data-variant="([^"]+)"/)[1], checking.match(/data-variant="([^"]+)"/)[1])
  assert.equal(idle.match(/data-size="([^"]+)"/)[1], checking.match(/data-size="([^"]+)"/)[1])
  assert.equal(idle.slice(idle.indexOf('<svg')), checking.slice(checking.indexOf('<svg')))
})

test('recording errors keep the draft editable and expose explicit dismissal', () => {
  const html = renderComposer({ status: 'error', error: 'Allow microphone access, then try again.' })
  assert.match(html, /Existing draft/)
  assert.match(html, /role="status">Allow microphone access/)
  assert.match(html, /aria-label="Dismiss recording error"/)
})


test('capture state reaches the unified composer without replacing conversation messages', () => {
  globalThis.__viewCapture = { ...capture, status: 'recording', inputBands: Array(32).fill(0.2), finalize: async () => null }
  try {
    const html = render({ turns: [{ id: 'one', userText: 'Hello', assistantText: 'Hi', status: 'complete', error: null }] })
    assert.match(html, /data-dictating="true"/)
    assert.match(html, /aria-label="Cancel recording"/)
    assert.match(html, /Recording. Stop to insert the transcript/)
    assert.match(html, /data-message-id="one"/)
    assert.doesNotMatch(html, /aria-label="Start call"|aria-label="Start recording"/)
  } finally { delete globalThis.__viewCapture }
})
