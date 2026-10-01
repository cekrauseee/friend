import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { createAccentPreference } from '../src/lib/accent-preference.ts'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const react = dataModule(`
  const current = () => globalThis.__accentOrb;
  export const useState = (initial) => {
    const f = current(), i = f.cursor++;
    if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? initial() : initial;
    return [f.values[i], (value) => { f.values[i] = typeof value === 'function' ? value(f.values[i]) : value; }];
  };
  export const useRef = (initial) => useState(() => ({ current: initial }))[0];
  export const useEffect = (effect, dependencies) => {
    const f = current(), i = f.cursor++, previous = f.effects[i];
    if (previous && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return;
    f.pending.push(() => { previous?.cleanup?.(); f.effects[i] = { dependencies, cleanup: effect() }; });
  };
  export const useLayoutEffect = useEffect;
  export const useMemo = (make) => make();
`)
const imports = {
  react,
  '@/hooks/use-accent-preference': dataModule('export const useAccentPreference = () => globalThis.__accentOrb.store.getSnapshot();'),
  'motion/react': dataModule(`
    export const motion = { div: 'div', span: 'span' };
    export const useReducedMotion = () => globalThis.__accentOrb.reduced;
    export const useMotionValue = () => globalThis.__accentOrb.y;
    export const animate = (_, target) => { globalThis.__accentOrb.moves.push(target); return { stop() {} }; };
  `),
  '@/lib/composer-size': dataModule('export const composerMorph = { duration: 0.16 };'),
}
const modules = new Map()
async function load(path) {
  if (modules.has(path)) return modules.get(path)
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText
  for (const name of new Set([...code.matchAll(/from ["']([^"']+)["']/g)].map((match) => match[1]))) {
    const resolved = imports[name] ?? (name.startsWith('@/') ? await load(`src/${name.slice(2)}.tsx`) : import.meta.resolve(name))
    code = code.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`).replaceAll(`from '${name}'`, `from ${JSON.stringify(resolved)}`)
  }
  const result = dataModule(code)
  modules.set(path, result)
  return result
}
const { DotOrb } = await import(await load('src/components/dot-orb.tsx'))
const { CompactAgentOrb } = await import(await load('src/components/compact-agent-orb.tsx'))
const { Shdr14 } = await import(await load('src/components/ui/shdr-14.tsx'))
const { ShaderOrb } = await import(await load('src/components/ui/orbkit-core.tsx'))

function find(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  for (const child of [element.props?.children].flat(Infinity)) {
    const result = find(child, predicate)
    if (result) return result
  }
  return null
}
function hooks(store) {
  return { store, cursor: 0, values: [], effects: [], pending: [], reduced: false, moves: [], y: { set(value) { this.value = value } } }
}
function render(f, component, props, attach = () => {}) {
  globalThis.__accentOrb = f
  f.cursor = 0
  const element = component(props)
  attach(element)
  for (const effect of f.pending.splice(0)) effect()
  return element
}
function dispose(f) { for (const effect of f.effects) effect?.cleanup?.() }
function browser(reduced = false) {
  const keys = ['window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'IntersectionObserver']
  const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]))
  const frames = new Map()
  const observers = []
  let time = 1000, id = 0
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: reduced }), addEventListener() {}, removeEventListener() {} }
  globalThis.performance = { now: () => time }
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = (frame) => frames.delete(frame)
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
  }
  globalThis.IntersectionObserver = undefined
  return { frames, observers,
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        time += 1000 / 60
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach((callback) => callback())
      }
    },
    restore() { Object.assign(globalThis, originals); delete globalThis.__accentOrb },
  }
}
function canvas() {
  const calls = { contexts: 0, programs: 0, deleted: 0, draws: 0, uniforms: new Map() }
  const gl = new Proxy({
    getExtension: () => null, isContextLost: () => false,
    createShader: () => ({}), getShaderParameter: () => true,
    createProgram: () => { calls.programs++; return {} }, getProgramParameter: () => true,
    createBuffer: () => ({}), getAttribLocation: () => 0, getUniformLocation: (_, name) => name,
    uniform1f: (name, value) => calls.uniforms.set(name, value),
    uniform3f: (name, ...value) => calls.uniforms.set(name, value),
    drawArrays: () => calls.draws++, deleteProgram: () => calls.deleted++,
  }, { get: (target, key) => target[key] ?? (() => {}) })
  return { calls, element: { clientWidth: 160, clientHeight: 160, width: 0, height: 0, style: {},
    getContext() { calls.contexts++; return gl }, addEventListener() {}, removeEventListener() {},
  } }
}
function shader(f, props, c) {
  const element = Shdr14(props)
  return render(f, ShaderOrb, element.props, (tree) => { find(tree, (node) => node.type === 'canvas').props.ref.current = c.element })
}
const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
const near = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${value} != ${expected[index]}`))

test('both Orb consumers propagate seed/appearance/state palettes and restore exact neutral defaults', () => {
  const store = createAccentPreference()
  const large = hooks(store), compact = hooks(store)
  try {
    const initial = render(large, DotOrb, { level: 0.6 }).props
    assert.deepEqual(initial.colors, { ink: '#181b20', paper: '#c2ccd8' })
    const neutralStates = { thinking: { ink: '#18103b', paper: '#b6aaff' }, speaking: { ink: '#2a1410', paper: '#ffd9a4' }, idle: initial.colors }
    for (const seed of ['#f53f83', '#247bad', null]) {
      store.setSeed(seed)
      const dot = render(large, DotOrb, { level: 0.6 }).props
      assert.deepEqual(dot.colors, store.getSnapshot().palette?.orb ?? initial.colors)
      assert.deepEqual(dot.volumes, initial.volumes)
      assert.deepEqual(dot.params, initial.params)
      assert.deepEqual(dot.style, initial.style)
      for (const [status, state] of [['waiting', 'thinking'], ['streaming', 'speaking'], ['complete', 'idle']]) {
        const tree = render(compact, CompactAgentOrb, { status })
        const props = find(tree, (node) => node.type === Shdr14).props
        assert.equal(props.state, state)
        assert.deepEqual(props.stateColors, store.getSnapshot().palette?.orbStates ?? neutralStates)
        assert.deepEqual(props.stateVolumes, { thinking: { input: 0.45, output: 0.5 }, speaking: { input: 0.65, output: 0.8 }, idle: { input: 0, output: 0.3 } })
        assert.equal(props.size, 32)
        assert.equal(props.maxDpr, 2)
      }
    }
  } finally { dispose(large); dispose(compact); store.dispose(); delete globalThis.__accentOrb }
})

test('appearance events propagate to both mounted consumers without restarting compact positioning', () => {
  const b = browser()
  let change
  const store = createAccentPreference({ media: { matches: false, addEventListener(_, listener) { change = listener }, removeEventListener() {} } })
  const large = hooks(store), compact = hooks(store)
  const anchor = { offsetTop: 80, parentElement: {} }
  const drawCompact = () => render(compact, CompactAgentOrb, { status: 'waiting' }, (tree) => {
    find(tree, (node) => node.props?.className === 'conversation-orb-anchor').props.ref.current = anchor
  })
  try {
    store.setSeed('#f53f83')
    const light = render(large, DotOrb, { level: 0 }).props.colors
    drawCompact()
    assert.equal(b.observers.length, 1)
    assert.equal(compact.y.value, 80)
    change({ matches: true })
    assert.notDeepEqual(store.getSnapshot().palette.orb, light)
    assert.deepEqual(render(large, DotOrb, { level: 0 }).props.colors, store.getSnapshot().palette.orb)
    assert.deepEqual(find(drawCompact(), (node) => node.type === Shdr14).props.stateColors, store.getSnapshot().palette.orbStates)
    assert.equal(b.observers.length, 1)
    anchor.offsetTop = 96
    b.observers[0].callback()
    b.step()
    assert.deepEqual(compact.moves, [96])
    change({ matches: false })
    assert.deepEqual(render(large, DotOrb, { level: 0 }).props.colors, light)
  } finally { dispose(large); dispose(compact); store.dispose(); b.restore() }
})

test('live shader colors spring through uniform updates and reset without replacing WebGL or altering audio/geometry', () => {
  const b = browser()
  const store = createAccentPreference()
  const f = hooks(store), control = hooks(store), c = canvas(), baseline = canvas()
  const initial = { colors: { ink: '#181b20', paper: '#c2ccd8' }, volumes: { input: 0, output: 0.625 }, params: { radius: 0.91, speed: 0.825, spin: 0.2, rim: 0, gain: 0.95 } }
  const random = Math.random
  Math.random = () => 0.5
  try {
    shader(f, initial, c)
    shader(control, initial, baseline)
    const start = [...c.calls.uniforms.get('uC_paper')]
    store.setSeed('#f53f83')
    const colors = store.getSnapshot().palette.orb
    shader(f, { ...initial, colors }, c)
    assert.deepEqual(c.calls.uniforms.get('uC_paper'), start)
    b.step()
    const between = c.calls.uniforms.get('uC_paper')
    assert.notDeepEqual(between, start)
    assert.notDeepEqual(between, rgb(colors.paper))
    b.step(600)
    near(c.calls.uniforms.get('uC_paper'), rgb(colors.paper))
    for (const [key, value] of baseline.calls.uniforms) if (!key.startsWith('uC_')) assert.equal(c.calls.uniforms.get(key), value, key)
    store.reset()
    shader(f, initial, c)
    b.step(600)
    near(c.calls.uniforms.get('uC_ink'), rgb(initial.colors.ink))
    near(c.calls.uniforms.get('uC_paper'), rgb(initial.colors.paper))
    assert.equal(c.calls.contexts, 1)
    assert.equal(c.calls.programs, 1)
    assert.equal(c.calls.deleted, 0)
    assert.equal(c.element.width, baseline.element.width)
  } finally { Math.random = random; dispose(f); dispose(control); store.dispose(); b.restore() }
})

test('reduced-motion Orbs repaint accent/appearance/state/reset in the same context with no animation frames', () => {
  const b = browser(true)
  let change
  const store = createAccentPreference({ media: { matches: false, addEventListener(_, listener) { change = listener }, removeEventListener() {} } })
  const f = hooks(store), c = canvas()
  const neutral = { thinking: { ink: '#18103b', paper: '#b6aaff' }, speaking: { ink: '#2a1410', paper: '#ffd9a4' }, idle: { ink: '#181b20', paper: '#c2ccd8' } }
  const stateVolumes = { thinking: { input: 0.45, output: 0.5 }, speaking: { input: 0.65, output: 0.8 }, idle: { input: 0, output: 0.3 } }
  try {
    shader(f, { state: 'idle', stateColors: neutral, stateVolumes }, c)
    const time = c.calls.uniforms.get('uTime'), clock = c.calls.uniforms.get('uP_speed')
    for (const seed of ['#247bad', null]) {
      store.setSeed(seed)
      for (const dark of [true, false]) {
        change({ matches: dark })
        for (const state of ['thinking', 'speaking', 'idle']) {
          const stateColors = store.getSnapshot().palette?.orbStates ?? neutral
          shader(f, { state, stateColors, stateVolumes }, c)
          near(c.calls.uniforms.get('uC_ink'), rgb(stateColors[state].ink))
          near(c.calls.uniforms.get('uC_paper'), rgb(stateColors[state].paper))
          assert.equal(c.calls.uniforms.get('uInput'), stateVolumes[state].input)
          assert.equal(c.calls.uniforms.get('uOutput'), stateVolumes[state].output)
          assert.equal(c.calls.uniforms.get('uTime'), time)
          assert.equal(c.calls.uniforms.get('uP_speed'), clock)
        }
      }
    }
    assert.equal(b.frames.size, 0)
    assert.equal(c.calls.contexts, 1)
    assert.equal(c.calls.programs, 1)
    assert.equal(c.calls.deleted, 0)
    assert.equal(c.calls.draws, 13)
  } finally { dispose(f); store.dispose(); b.restore() }
})
