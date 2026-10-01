import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { createAccentPreference } from '../src/lib/accent-preference.ts'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const cache = new Map()
async function loadModule(url) {
  if (cache.has(url.href)) return cache.get(url.href)
  let code = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    let resolved
    if (name === '@/lib/interface-sounds') resolved = dataModule('export const interfaceSounds = { play: (...args) => globalThis.__accentRuntime.sounds.push(args) }')
    else if (name.startsWith('.')) resolved = await loadModule(new URL(name.endsWith('.ts') ? name : `${name}.ts`, url))
    else resolved = import.meta.resolve(name)
    code = code.replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`).replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`)
  }
  const result = dataModule(code)
  cache.set(url.href, result)
  return result
}
const { BlossomColorPicker } = await import(await loadModule(new URL('../src/components/ui/blossom%20picker/BlossomColorPicker.ts', import.meta.url)))
const { accentPickerValue } = await import(await loadModule(new URL('../src/lib/accent-picker.ts', import.meta.url)))

function domFixture() {
  const originals = { document: globalThis.document, window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  const globalEvents = new Map()
  const frames = new Map()
  let frameId = 0
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.style = {}; this.attrs = new Map(); this.events = new Map()
      this.classList = { add: (...names) => { this.className = `${this.className ?? ''} ${names.join(' ')}`.trim() } }
      this.dataset = {}; this.tabIndex = -1; this.disabled = false
    }
    setAttribute(name, value) { this.attrs.set(name, String(value)); if (name.toLowerCase() === 'tabindex') this.tabIndex = Number(value) }
    getAttribute(name) { return this.attrs.get(name) ?? null }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)) }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(callback) }
    removeEventListener(name, callback) { this.events.get(name)?.delete(callback) }
    dispatch(name, options = {}) {
      const event = { target: this, key: '', shiftKey: false, clientX: 100, clientY: 100, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...options }
      for (let el = this; el; el = el.parentNode) for (const callback of el.events.get(name) ?? []) callback(event)
      return event
    }
    focus() { globalThis.document.activeElement = this; this.dispatch('focusin') }
    getBoundingClientRect() { return { left: 0, top: 0, width: Number.parseFloat(this.style.width ?? this.attrs.get('width')) || 32, height: Number.parseFloat(this.style.height ?? this.attrs.get('height')) || 32, right: 32, bottom: 32 } }
  }
  const listeners = { addEventListener(name, callback) { if (!globalEvents.has(name)) globalEvents.set(name, new Set()); globalEvents.get(name).add(callback) }, removeEventListener(name, callback) { globalEvents.get(name)?.delete(callback) } }
  globalThis.document = { createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), ...listeners }
  globalThis.window = { innerWidth: 320, innerHeight: 600, ...listeners }
  globalThis.requestAnimationFrame = (callback) => { const id = ++frameId; frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  globalThis.__accentRuntime = { sounds: [] }
  const container = new Element('div')
  const all = (node = container) => [node, ...node.children.flatMap((child) => all(child))]
  return { container, frames, globalEvents, all, petals: () => all().filter((el) => el.getAttribute('aria-label')?.startsWith('Select color')), slider: () => all().find((el) => el.getAttribute('role') === 'slider'), sounds: globalThis.__accentRuntime.sounds,
    restore() { Object.assign(globalThis, originals); delete globalThis.__accentRuntime } }
}

const openOptions = { initialExpanded: true, collapsible: false, openOnHover: false, adaptivePositioning: false, animationDuration: 0, sliderOffset: 22 }

test('opening/reopening and controlled seed echoes preserve neutral and saved preferences without emitting changes', () => {
  const f = domFixture()
  try {
    for (const seed of [null, '#7597ac']) {
      const store = createAccentPreference({ storage: null, media: null, events: null, style: null })
      if (seed) store.setSeed(seed)
      let changes = 0
      for (let i = 0; i < 2; i++) {
        const picker = new BlossomColorPicker(f.container, { ...openOptions, value: accentPickerValue(store.getSnapshot().seed), onChange(color) { changes++; store.setSeed(color.hex) } })
        picker.setOptions({ value: accentPickerValue(store.getSnapshot().seed) })
        assert.equal(store.getSnapshot().seed, seed)
        assert.equal(changes, 0)
        picker.destroy()
      }
      store.dispose()
    }
    assert.deepEqual(f.sounds, [])
  } finally { f.restore() }
})

test('petals apply/persist an opaque seed live; arc keyboard raises lightness and controlled updates preserve shade', () => {
  const f = domFixture()
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const store = createAccentPreference({ storage, media: null, events: null, style: null })
  let picker
  try {
    let changes = 0
    picker = new BlossomColorPicker(f.container, { ...openOptions, value: accentPickerValue(null), onChange(color) { changes++; store.setSeed(color.hex); picker.setValue(color) } })
    f.petals()[5].dispatch('click')
    assert.equal(changes, 1)
    assert.match(store.getSnapshot().seed, /^#[a-f0-9]{6}$/)
    assert.equal(JSON.parse(values.get('dot:accent-color')).seed, store.getSnapshot().seed)
    assert.equal(picker.getValue().hex, store.getSnapshot().seed)
    const firstLightness = picker.getValue().lightness
    f.slider().dispatch('keydown', { key: 'ArrowUp' })
    assert.equal(changes, 2)
    assert.ok(picker.getValue().lightness > firstLightness)
    assert.equal(picker.getValue().hex, store.getSnapshot().seed)
    assert.deepEqual(f.sounds.map(([cue]) => cue), ['accentSelect', 'accentShade'])
    f.slider().dispatch('keydown', { key: 'End' })
    assert.equal(picker.getValue().lightness, 95)
    f.slider().dispatch('keydown', { key: 'Home' })
    assert.equal(picker.getValue().lightness, 5)
    store.reset()
    picker.setValue(accentPickerValue(null))
    assert.equal(store.getSnapshot().palette, null)
    assert.equal(values.size, 0)
  } finally { picker?.destroy(); store.dispose(); f.restore() }
})

test('petal arrows rove one Tab stop; collapsed/disabled petals and arc cannot change color', () => {
  const f = domFixture()
  let picker
  try {
    let changes = 0
    picker = new BlossomColorPicker(f.container, { ...openOptions, collapsible: true, onChange() { changes++ } })
    const petals = f.petals()
    assert.equal(petals.filter((el) => el.tabIndex === 0).length, 1)
    petals[0].focus()
    const event = petals[0].dispatch('keydown', { key: 'ArrowRight' })
    assert.equal(event.defaultPrevented, true)
    assert.equal(document.activeElement, petals[1])
    assert.equal(petals[0].tabIndex, -1)
    assert.equal(petals[1].tabIndex, 0)
    picker.collapse()
    assert.ok(petals.every((el) => el.tabIndex === -1 && el.disabled))
    assert.equal(f.slider().tabIndex, -1)
    f.slider().dispatch('keydown', { key: 'ArrowUp' })
    petals[1].dispatch('click')
    assert.equal(changes, 0)
    picker.expand()
    picker.setOptions({ disabled: true })
    assert.ok(f.petals().every((el) => el.tabIndex === -1 && el.disabled))
    assert.equal(f.slider().getAttribute('aria-disabled'), 'true')
    f.slider().dispatch('keydown', { key: 'ArrowUp' })
    assert.equal(changes, 0)
  } finally { picker?.destroy(); f.restore() }
})

test('only color-entry hover sounds; reduced-motion initialization avoids movement and destruction cancels dragging/listeners/RAF', () => {
  const f = domFixture()
  let picker
  try {
    picker = new BlossomColorPicker(f.container, openOptions)
    const container = f.all().find((el) => el.className === 'bcp-container')
    container.dispatch('mouseenter')
    f.petals()[0].dispatch('mouseenter')
    f.slider().dispatch('mouseenter')
    container.dispatch('mousemove')
    assert.equal(f.frames.size, 0)
    assert.deepEqual(f.sounds, [['accentHover']])
    assert.ok(f.petals().every((el) => el.style.transition.includes('transform 0ms')))
    picker.setOptions({ animationDuration: 280 })
    container.dispatch('mousemove')
    assert.equal(f.frames.size, 1)
    f.slider().dispatch('mousedown')
    assert.equal(f.globalEvents.get('mousemove').size, 1)
    picker.destroy()
    assert.equal(f.frames.size, 0)
    assert.ok([...f.globalEvents.values()].every((set) => set.size === 0))
    assert.equal(f.container.children.length, 0)
  } finally { picker?.destroy(); f.restore() }
})

async function uiComponent() {
  let code = ts.transpileModule(await readFile(new URL('../src/components/accent-picker.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mocks = {
    react: `export const useCallback = (fn) => fn;
      export const useId = () => 'id-' + globalThis.__accentUI.ids++;
      export function useState(initial) { const r = globalThis.__accentUI; const i = r.stateIndex++; if (!(i in r.states)) r.states[i] = typeof initial === 'function' ? initial() : initial; return [r.states[i], (value) => { r.states[i] = value }]; }
      export function useRef(initial) { const r = globalThis.__accentUI; const i = r.refIndex++; return r.refs[i] ??= { current: initial }; }`,
    'motion/react': 'export const motion = { div: "motion.div" }; export const useReducedMotion = () => false;',
    '@/components/ui/button': 'export const Button = "button";',
    '@/components/ui/popover': 'export const Popover = "popover"; export const PopoverTrigger = "trigger"; export const PopoverContent = "content";',
    '@/components/ui/color-picker-standalone': 'export const BlossomPicker = "blossom";',
    '@/hooks/use-accent-preference': 'export const useAccentPreference = () => globalThis.__accentUI.store.getSnapshot();',
    '@/lib/accent-preference': 'export const accentPreference = { setSeed: (seed) => globalThis.__accentUI.store.setSeed(seed), reset: () => globalThis.__accentUI.store.reset() };',
    '@/lib/interface-sounds': 'export const interfaceSounds = { play: (...args) => globalThis.__accentUI.sounds.push(args) };',
  }
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = name in mocks ? dataModule(mocks[name]) : name.startsWith('@/') ? await loadModule(new URL(`../src/${name.slice(2)}.ts`, import.meta.url)) : import.meta.resolve(name)
    code = code.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`).replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  return (await import(dataModule(code))).AccentPicker
}
const AccentPicker = await uiComponent()
function uiFixture(seed = null) {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const store = createAccentPreference({ storage, media: null, events: null, style: null })
  if (seed) store.setSeed(seed)
  const runtime = { store, sounds: [], refs: [], states: [], stateIndex: 0, refIndex: 0, ids: 0 }
  globalThis.__accentUI = runtime
  const flatten = (node) => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(2).flatMap(flatten)]
  return { runtime, store, values, render() { runtime.stateIndex = 0; runtime.refIndex = 0; return flatten(AccentPicker()) }, restore() { store.dispose(); delete globalThis.__accentUI } }
}

test('interface trigger opens below/end, preview applies a real selection and Restore neutral clears persistence', () => {
  const f = uiFixture()
  try {
    let nodes = f.render()
    const find = (type) => nodes.find((node) => node.type === type)
    assert.equal(find('button').props['aria-label'], 'Accent color')
    assert.equal(find('button').props.size, 'icon-lg')
    assert.equal(find('popover').props.open, false)
    assert.equal(f.store.getSnapshot().seed, null)
    find('popover').props.onOpenChange(true)
    nodes = f.render()
    assert.equal(find('popover').props.open, true)
    assert.equal(find('content').props.side, 'bottom')
    assert.equal(find('content').props.align, 'end')
    assert.equal(find('content').props.collisionPadding, 16)
    assert.equal(find('blossom').props.initialExpanded, true)
    assert.equal(find('blossom').props.collapsible, false)
    assert.equal(find('blossom').props.openOnHover, false)
    assert.equal(find('blossom').props.value.alpha, 100)
    assert.deepEqual(f.runtime.sounds, [['accentOpen', true]])
    assert.equal(f.store.getSnapshot().seed, null)
    find('blossom').props.onChange({ ...accentPickerValue('#508fc4'), hex: '#508fc4' })
    nodes = f.render()
    assert.equal(f.store.getSnapshot().seed, '#508fc4')
    assert.equal(nodes.find((node) => node.props?.className === 'accent-swatch').props.style.backgroundColor, f.store.getSnapshot().palette.primary)
    assert.ok(nodes.some((node) => node.props?.children === '#508FC4'))
    nodes.find((node) => node.type === 'button' && node.props.children === 'Restore neutral').props.onClick()
    nodes = f.render()
    assert.equal(f.store.getSnapshot().palette, null)
    assert.equal(f.values.size, 0)
    assert.equal(nodes.find((node) => node.props?.children === 'Restore neutral').props.disabled, true)
    assert.deepEqual(f.runtime.sounds.at(-1), ['accentReset', true])
  } finally { f.restore() }
})

test('dismissal callback restores focus and reopening keeps the saved color without a change loop', () => {
  const f = uiFixture('#508fc4')
  try {
    let nodes = f.render()
    const popup = () => nodes.find((node) => node.type === 'popover')
    const panel = () => nodes.find((node) => node.type === 'content')
    let triggerFocus = 0, petalFocus = 0
    f.runtime.refs[0].current = { focus(options) { triggerFocus++; assert.equal(options.preventScroll, true) } }
    f.runtime.refs[1].current = { querySelector() { return { focus() { petalFocus++ } } } }
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
    popup().props.onOpenChange(true)
    nodes = f.render()
    const opening = event()
    panel().props.onOpenAutoFocus(opening)
    assert.equal(opening.prevented, true)
    assert.equal(petalFocus, 1)
    popup().props.onOpenChange(false)
    nodes = f.render()
    assert.equal(panel().props.inert, true)
    assert.equal(panel().props['aria-hidden'], true)
    const closingPicker = nodes.find((node) => node.type === 'blossom')
    assert.equal(closingPicker.props.disabled, true)
    closingPicker.props.onChange({ ...accentPickerValue('#aa55ee'), hex: '#aa55ee' })
    nodes.find((node) => node.props?.children === 'Restore neutral').props.onClick()
    assert.equal(f.store.getSnapshot().seed, '#508fc4')
    const closing = event()
    panel().props.onCloseAutoFocus(closing)
    assert.equal(closing.prevented, true)
    assert.equal(triggerFocus, 1)
    nodes = f.render()
    popup().props.onOpenChange(true)
    nodes = f.render()
    assert.equal(f.store.getSnapshot().seed, '#508fc4')
    assert.equal(nodes.find((node) => node.type === 'blossom').props.value.alpha, 100)
    assert.ok('data-appearance-control' in panel().props)
    assert.ok('data-appearance-control' in nodes.find((node) => node.type === 'button').props)
    assert.deepEqual(f.runtime.sounds.map(([cue]) => cue), ['accentOpen', 'accentOpen'])
  } finally { f.restore() }
})

test('React wrapper respects reduced motion during constructor and first update, even before Motion reports it', async () => {
  const source = await readFile(new URL('../src/components/ui/color-picker-standalone.tsx', import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mocks = {
    react: 'export const forwardRef = (render) => render; export const useRef = (value) => ({ current: value }); export const useEffect = (effect) => globalThis.__accentWrapper.effects.push(effect); export const useLayoutEffect = useEffect;',
    'motion/react': 'export const useReducedMotion = () => null;',
    './blossom picker/BlossomColorPicker': `export class BlossomColorPicker { constructor(_container, options) { globalThis.__accentWrapper.calls.push(options) } setOptions(options) { globalThis.__accentWrapper.calls.push(options) } destroy() { globalThis.__accentWrapper.destroyed++ } }`,
    './blossom picker/styles': 'export const blossomPickerStyles = "";',
  }
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = name in mocks ? dataModule(mocks[name]) : import.meta.resolve(name)
    code = code.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`).replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  const { BlossomPicker } = await import(dataModule(code))
  const original = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  globalThis.__accentWrapper = { effects: [], calls: [], destroyed: 0 }
  try {
    const outer = BlossomPicker({ animationDuration: 280, initialExpanded: true }, null)
    const inner = outer.type(outer.props, null)
    inner.props.children[1].props.ref({})
    const cleanup = globalThis.__accentWrapper.effects[0]()
    globalThis.__accentWrapper.effects[1]()
    assert.equal(globalThis.__accentWrapper.calls.length, 2)
    assert.ok(globalThis.__accentWrapper.calls.every((options) => options.animationDuration === 0))
    cleanup()
    assert.equal(globalThis.__accentWrapper.destroyed, 1)
  } finally { globalThis.window = original; delete globalThis.__accentWrapper }
})

test('reserved picker space contains the petals, color ring and reachable arc handle at the 320px popover width', async () => {
  const { DEFAULT_COLORS } = await import(await loadModule(new URL('../src/components/ui/blossom%20picker/constants.ts', import.meta.url)))
  const { organizeColorsIntoLayers } = await import(await loadModule(new URL('../src/components/ui/blossom%20picker/utils.ts', import.meta.url)))
  const { calculateLayerRadii, calculateBarRadius } = await import(await loadModule(new URL('../src/components/ui/blossom%20picker/layout.ts', import.meta.url)))
  const radii = calculateLayerRadii(organizeColorsIntoLayers(DEFAULT_COLORS), 32, 32)
  const barRadius = calculateBarRadius(radii, 32, 32, 20)
  const visibleExtent = Math.max(radii.at(-1) + 16 + 6, barRadius + 6, barRadius + 22 + 12)
  assert.ok(visibleExtent * 2 < 320 - 32 - 32 - 2)
})


test('a petal sounds once per entry, never on pointer movement or disabled/closed/decorative hover', () => {
  const f = domFixture()
  let picker
  try {
    picker = new BlossomColorPicker(f.container, { ...openOptions, collapsible: true })
    const petal = f.petals()[0]
    petal.dispatch('mouseenter')
    petal.dispatch('mouseenter')
    petal.dispatch('mousemove')
    assert.deepEqual(f.sounds, [['accentHover']])
    petal.dispatch('mouseleave')
    petal.dispatch('mouseenter')
    assert.equal(f.sounds.length, 2)
    const decorative = f.all().find((el) => el.className?.includes('bcp-petal') && el.getAttribute('aria-hidden') === 'true')
    decorative.dispatch('mouseenter')
    picker.setOptions({ disabled: true })
    petal.dispatch('mouseenter')
    assert.equal(f.sounds.length, 2)
    picker.setOptions({ disabled: false })
    picker.collapse()
    petal.dispatch('mouseenter')
    assert.equal(f.sounds.length, 2)
  } finally { picker?.destroy(); f.restore() }
})


test('disabling a closing picker immediately ends active arc dragging and blocks subsequent shade/hover feedback', () => {
  const f = domFixture()
  let picker
  try {
    let changes = 0
    picker = new BlossomColorPicker(f.container, { ...openOptions, onChange() { changes++ } })
    f.slider().dispatch('mousedown')
    assert.equal(f.globalEvents.get('mousemove').size, 1)
    picker.setOptions({ disabled: true })
    assert.equal(f.globalEvents.get('mousemove').size, 0)
    assert.equal(f.globalEvents.get('touchmove').size, 0)
    f.slider().dispatch('keydown', { key: 'ArrowUp' })
    f.petals()[0].dispatch('mouseenter')
    assert.equal(changes, 0)
    assert.deepEqual(f.sounds, [])
  } finally { picker?.destroy(); f.restore() }
})
