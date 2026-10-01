import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const css = await readFile(new URL('../src/App.css', import.meta.url), 'utf8')
const normalExit = css.match(/\.accent-popover\[data-state="closed"\]\s*\{[^}]*animation:\s*([\w-]+)\s+(\d+)ms\s+ease-out/s)
const reducedExit = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.accent-popover\[data-state="closed"\]\s*\{\s*animation-name:\s*([\w-]+)/s)

// Exercise the installed Radix presence hook with lifecycle doubles, without a browser.
// Resolve this transitive dependency from its owner under pnpm's isolated layout.
const radixRequire = createRequire(import.meta.resolve('radix-ui'))
const presenceEntry = new URL('./index.mjs', pathToFileURL(radixRequire.resolve('@radix-ui/react-presence')))
let source = await readFile(presenceEntry, 'utf8')
const hooks = dataModule(`export const useState = (...args) => globalThis.__presence.state(...args);
 export const useReducer = (...args) => globalThis.__presence.reducer(...args);
 export const useRef = (...args) => globalThis.__presence.ref(...args);
 export const useCallback = (...args) => globalThis.__presence.callback(...args);
 export const useEffect = (...args) => globalThis.__presence.effect('passive', ...args);`)
const layout = dataModule(`export const useLayoutEffect = (...args) => globalThis.__presence.effect('layout', ...args);`)
for (const name of new Set([...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]))) {
  const resolved = name === 'react' ? hooks : name === '@radix-ui/react-use-layout-effect' ? layout : import.meta.resolve(name)
  source = source.replaceAll(`from "${name}"`, `from ${JSON.stringify(resolved)}`)
}
source += '\nexport { usePresence };'
const { usePresence } = await import(dataModule(source))

function fixture(animationName) {
  const original = { computed: globalThis.getComputedStyle, CSS: globalThis.CSS }
  const slots = []
  const queue = { layout: [], passive: [] }
  let index = 0, dirty = false, present = true, result
  const same = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]))
  const runtime = {
    state(initial) { const i = index++; if (!slots[i]) slots[i] = { value: initial }; return [slots[i].value, (value) => { slots[i].value = value; dirty = true }]; },
    reducer(reducer, initial) { const i = index++; if (!slots[i]) slots[i] = { value: initial, send(event) { const next = reducer(slots[i].value, event); if (next !== slots[i].value) { slots[i].value = next; dirty = true } } }; return [slots[i].value, slots[i].send]; },
    ref(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    callback(fn, deps) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    effect(kind, effect, deps) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] ??= {}; slots[i].deps = deps; queue[kind].push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect() }); } },
  }
  const styles = { animationName: 'none', display: 'block' }
  const listeners = new Map()
  const jobs = new Map()
  let job = 0
  const node = { style: {}, ownerDocument: { defaultView: { setTimeout(fn) { const id = ++job; jobs.set(id, fn); return id }, clearTimeout(id) { jobs.delete(id) } } },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) } }
  globalThis.__presence = runtime
  globalThis.getComputedStyle = () => styles
  globalThis.CSS = { escape: (value) => value }
  const render = () => { index = 0; dirty = false; result = usePresence(present) }
  const settle = () => {
    let count = 0
    do {
      if (++count > 20) throw new Error('Presence failed to settle')
      for (const kind of ['layout', 'passive']) for (const effect of queue[kind].splice(0)) effect()
      if (dirty) render()
    } while (dirty || queue.layout.length || queue.passive.length)
    return result
  }
  render()
  result.ref(node)
  settle()
  return { styles, node, listeners, jobs,
    get mounted() { return result.isPresent },
    close() { styles.animationName = animationName; present = false; render(); return settle() },
    reopen() { styles.animationName = 'none'; present = true; render(); return settle() },
    event(name, event = {}) { for (const callback of listeners.get(name) ?? []) callback({ target: node, animationName, ...event }); return settle() },
    restore() { for (const slot of slots) slot?.cleanup?.(); globalThis.getComputedStyle = original.computed; globalThis.CSS = original.CSS; delete globalThis.__presence } }
}

test('popover exit is brief, noninteractive and reduced motion retains only an opacity fade', () => {
  assert.ok(normalExit)
  assert.equal(Number(normalExit[2]), 140)
  assert.match(css, /\.accent-popover\[data-state="closed"\]\s*\{\s*pointer-events: none;/)
  assert.ok(reducedExit)
  const keyframes = css.match(new RegExp(`@keyframes ${reducedExit[1]}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
  assert.match(keyframes, /opacity: 0/)
  assert.doesNotMatch(keyframes, /transform|translate|scale/)
})

test('installed Radix keeps closing content until the matching exit completes and removes animation listeners on cleanup', () => {
  for (const animation of [normalExit[1], reducedExit[1]]) {
    const f = fixture(animation)
    try {
      assert.equal(f.mounted, true)
      assert.equal(f.close().isPresent, true)
      f.event('animationend', { target: {} })
      assert.equal(f.mounted, true)
      f.event('animationend', { animationName: 'unrelated-animation' })
      assert.equal(f.mounted, true)
      assert.equal(f.event('animationend').isPresent, false)
      assert.equal(f.node.style.animationFillMode, 'forwards')
    } finally { f.restore() }
    assert.ok([...f.listeners.values()].every((set) => set.size === 0))
    assert.equal(f.jobs.size, 0)
  }
})

test('reopening during the native exit cancels removal without stale animation completion hiding the picker', () => {
  const f = fixture(normalExit[1])
  try {
    f.close()
    assert.equal(f.reopen().isPresent, true)
    f.event('animationcancel')
    assert.equal(f.mounted, true)
  } finally { f.restore() }
})

test('selection policy disables application/portal chrome, explicitly permits message/editing scopes, and uses the verified accent pair', async () => {
  const source = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const none = source.match(/([^{}]+)\{[^{}]*user-select:\s*none;[^{}]*\}/)?.[1]
  const text = source.match(/([^{}]+)\{[^{}]*user-select:\s*text;[^{}]*\}/)?.[1]
  assert.deepEqual(none.trim().replace(/^\/\*[\s\S]*?\*\//, '').trim().split(/,\s*/), ['#root', '[data-slot="popover-content"]', '[data-slot="alert-dialog-content"]'])
  assert.deepEqual(text.trim().split(/,\s*/), ['[data-selectable-message]', 'input', 'textarea', '[contenteditable]:not([contenteditable="false"])'])
  assert.match(source, /::selection\s*\{\s*background-color:\s*var\(--selection\);\s*color:\s*var\(--selection-foreground\);\s*\}/)
  assert.doesNotMatch(source, /(?:body|html|\*)\s*\{[^}]*user-select:\s*none/s)
})
