import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const source = await readFile(new URL('../src/hooks/use-composer-shortcuts.ts', import.meta.url), 'utf8')
let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
compiled = compiled.replace(/from ['"]react['"]/, `from ${JSON.stringify(dataModule('export const useEffect = (effect) => { globalThis.__composerRouting.cleanup = effect(); };'))}`)
  .replace(/from ['"]react-dom['"]/, `from ${JSON.stringify(import.meta.resolve('react-dom'))}`)
  .replace(/from ['"]@\/lib\/composer-shortcuts['"]/, `from ${JSON.stringify(new URL('../src/lib/composer-shortcuts.ts', import.meta.url).href)}`)
  .replace(/from ['"]@\/lib\/interface-sounds['"]/, `from ${JSON.stringify(dataModule('export const interfaceSounds = { play: (...args) => globalThis.__composerRouting.sounds.push(args) };'))}`)
const { useComposerShortcuts } = await import(dataModule(compiled))

function fixture({ enabled = true, voice = false, modal = false } = {}) {
  const originals = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element }
  const listeners = new Map()
  const runtime = { sounds: [], cleanup: null }
  globalThis.__composerRouting = runtime
  class FakeElement {
    constructor(editable = false, appearance = false) { this.editable = editable; this.appearance = appearance }
    closest(selector) {
      if (selector === '[data-calling="true"]') return voice ? this : null
      if (selector.startsWith('input, textarea')) return this.editable || this.appearance && selector.includes('[data-appearance-control]') ? this : null
      return null
    }
  }
  let opened = 0
  let focused = 0
  const input = Object.assign(new FakeElement(), {
    value: 'hello world', selectionStart: 11, selectionEnd: 11,
    focus(options) { focused++; assert.equal(options.preventScroll, true) },
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
  })
  globalThis.Element = FakeElement
  globalThis.document = { querySelector: () => modal ? {} : null }
  globalThis.window = { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type) => listeners.delete(type) }
  useComposerShortcuts({ enabled, open: false, inputRef: { current: input }, onOpen: () => opened++, onDraftChange: (draft) => { input.value = draft } })
  const dispatchKey = (key, options = {}) => {
    const event = { key, target: new FakeElement(), defaultPrevented: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false,
      getModifierState: () => false, preventDefault() { this.defaultPrevented = true }, ...options }
    listeners.get('keydown')?.(event)
    return event
  }
  return {
    input, runtime, dispatchKey, FakeElement,
    get opened() { return opened }, get focused() { return focused },
    paste(text, target = new FakeElement()) {
      const event = { target, clipboardData: { getData: () => text }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      listeners.get('paste')?.(event)
      return event
    },
    restore() { runtime.cleanup?.(); Object.assign(globalThis, originals); delete globalThis.__composerRouting },
  }
}

test('typing on the page opens and focuses the composer without losing or duplicating the first character', () => {
  const f = fixture()
  try {
    const event = f.dispatchKey('!')
    assert.equal(f.opened, 1)
    assert.equal(f.focused, 1)
    assert.equal(f.input.value, 'hello world!')
    assert.equal(f.input.selectionStart, 12)
    assert.equal(event.defaultPrevented, true)
    assert.equal(f.runtime.sounds.length, 1)
  } finally { f.restore() }
})

test('select-all and paste target the composer; trusted shortcut paste remains native', () => {
  const f = fixture()
  try {
    f.dispatchKey('a', { metaKey: true })
    assert.equal(f.input.selectionStart, 0)
    assert.equal(f.input.selectionEnd, 11)
    const shortcut = f.dispatchKey('v', { ctrlKey: true })
    assert.equal(shortcut.defaultPrevented, false)
    const paste = f.paste('new\nmessage')
    assert.equal(paste.defaultPrevented, true)
    assert.equal(f.input.value, 'new\nmessage')
    assert.equal(f.input.selectionStart, 11)
  } finally { f.restore() }
})

test('global deletion edits the composer and keyboard routing is disabled during voice', () => {
  const f = fixture()
  try {
    f.dispatchKey('Backspace', { ctrlKey: true })
    assert.equal(f.input.value, 'hello ')
    f.dispatchKey('Backspace', { metaKey: true })
    assert.equal(f.input.value, '')
  } finally { f.restore() }
  for (const options of [{ enabled: false }, { voice: true }]) {
    const voice = fixture(options)
    try { voice.dispatchKey('x'); assert.equal(voice.focused, 0); assert.equal(voice.input.value, 'hello world') }
    finally { voice.restore() }
  }
})

test('existing edit fields and active dialogs retain their own keyboard input', () => {
  const f = fixture()
  try {
    const event = f.dispatchKey('a', { target: new f.FakeElement(true), ctrlKey: true })
    assert.equal(f.focused, 0)
    assert.equal(event.defaultPrevented, false)
  } finally { f.restore() }
  const modal = fixture({ modal: true })
  try { modal.dispatchKey('a'); assert.equal(modal.focused, 0) } finally { modal.restore() }
})


test('appearance controls retain keys and paste without opening or editing the composer', () => {
  const f = fixture()
  try {
    for (const key of ['a', 'Backspace', ' ', 'ArrowUp', 'Escape']) {
      const event = f.dispatchKey(key, { target: new f.FakeElement(false, true), ctrlKey: key === 'a' })
      assert.equal(event.defaultPrevented, false)
    }
    const paste = f.paste('ignored', new f.FakeElement(false, true))
    assert.equal(paste.defaultPrevented, false)
    assert.equal(f.focused, 0)
    assert.equal(f.opened, 0)
    assert.equal(f.input.value, 'hello world')
    assert.equal(f.runtime.sounds.length, 0)
  } finally { f.restore() }
})
