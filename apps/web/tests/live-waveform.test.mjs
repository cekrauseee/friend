import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const react = moduleUrl(`
  const fixture = () => globalThis.__waveform;
  export const useRef = value => { const f = fixture(); return f.refs[f.refIndex++] ??= { current: value }; };
  export const useEffectEvent = callback => callback;
  export const useEffect = callback => fixture().effects.push(callback);
`)
const imports = {
  react,
  'motion/react': moduleUrl('export const useReducedMotion = () => globalThis.__waveform.reduced;'),
  '@/lib/utils': moduleUrl('export const cn = (...values) => values.filter(Boolean).join(" ");'),
  '@/lib/waveform-layout': import.meta.resolve('../src/lib/waveform-layout.ts'),
}
let code = ts.transpileModule(await readFile(new URL('../src/components/ui/live-waveform.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
}).outputText
for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map(match => match[1]))) {
  code = code.replaceAll(`from '${name}'`, `from ${JSON.stringify(imports[name] ?? import.meta.resolve(name))}`)
    .replaceAll(`from "${name}"`, `from ${JSON.stringify(imports[name] ?? import.meta.resolve(name))}`)
}
const { LiveWaveform } = await import(moduleUrl(code))

function mount(t, props, reduced = false) {
  const frames = new Map(), bars = [], cleanup = []
  let frameId = 0, disconnected = false
  const rect = { width: 192, height: 24 }
  const context = { clearRect() {}, setTransform() {}, beginPath() {}, fill() {},
    roundRect: (...args) => bars.push(args), globalAlpha: 1 }
  const canvas = { getBoundingClientRect: () => rect, getContext: () => context, style: {} }
  const container = { getBoundingClientRect: () => rect }
  const fixture = { refs: [], refIndex: 0, effects: [], reduced }
  const globals = {
    __waveform: fixture,
    window: { devicePixelRatio: 2 },
    navigator: { mediaDevices: { getUserMedia() { assert.fail('Renderer must not capture a second microphone') } } },
    getComputedStyle: () => ({ color: 'rgb(255, 255, 255)' }),
    ResizeObserver: class { observe() {} disconnect() { disconnected = true } },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: id => frames.delete(id),
  }
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.entries(globals).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }))
  const view = LiveWaveform(props)
  view.props.ref.current = container
  view.props.children.props.ref.current = canvas
  fixture.effects.forEach(effect => { const dispose = effect(); if (dispose) cleanup.push(dispose) })
  t.after(() => {
    cleanup.forEach(dispose => dispose())
    assert.equal(frames.size, 0)
    assert.equal(disconnected, true)
    saved.forEach(([key, descriptor]) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key])
  })
  return { bars, frames, frame(time) {
    const callbacks = [...frames.values()]; frames.clear()
    callbacks.forEach(callback => callback(time))
  } }
}

test('controlled LiveWaveform renders measured audio without owning capture or an idle animation loop', t => {
  const { bars, frames } = mount(t, { data: Array(32).fill(0.5), active: true })
  assert.ok(bars.length > 0)
  assert.ok(bars.every(bar => Math.abs(bar[3] - 9.6) < 0.001))
  assert.equal(frames.size, 0)
})

test('visual sensitivity makes quiet speech visible and caps peaks within the waveform', t => {
  const { bars } = mount(t, { data: [0, 0.15, 0.9], active: true, sensitivity: 1.8 })
  assert.ok(bars.some(bar => bar[3] > 3 && bar[3] < 10))
  assert.ok(bars.some(bar => bar[3] === 3), 'zero input stays at the idle baseline')
  assert.ok(bars.every(bar => bar[3] <= 24 * 0.8), 'loud speech does not overflow the canvas')
})

test('processing animates on the canvas, cancels its loop on unmount, and is static under reduced motion', t => {
  const waveform = mount(t, { data: [], processing: true })
  assert.equal(waveform.frames.size, 1)
  waveform.frame(0)
  waveform.frame(500)
  assert.ok(waveform.bars.some(bar => bar[3] > 3))
})

test('reduced-motion processing still shows a waiting pattern without scheduling animation', t => {
  const { frames, bars } = mount(t, { data: [], processing: true }, true)
  assert.ok(bars.some(bar => bar[3] > 3))
  assert.equal(frames.size, 0)
})
