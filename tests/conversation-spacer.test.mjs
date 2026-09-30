import assert from 'node:assert/strict'
import test from 'node:test'
import { attachConversationScrollMotion } from '../src/lib/conversation-scroll-motion.ts'
import { attachConversationSpacer } from '../src/lib/conversation-spacer.ts'

function fixture(reducedMotion = true) {
  const keys = ['window', 'performance', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
  const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]))
  let now = 1
  let nextFrame = 0
  const frames = new Map()
  const observers = []
  const listeners = new Map()
  const items = []
  const spacerNode = { hidden: true, style: { height: '0px', marginTop: '' } }
  const spacerHeight = () => parseFloat(spacerNode.style.height) || 0
  let top = 0
  const end = () => items.length ? items.at(-1).position() + items.at(-1).offsetHeight + 24 : 0
  const scroll = {
    clientTop: 0, clientHeight: 900,
    get scrollHeight() { return Math.max(this.clientHeight, end() + spacerHeight()) },
    get scrollTop() { return top },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
    scrollTo(options) { this.scrollTop = options.top },
    getBoundingClientRect: () => ({ top: 16 }),
    querySelector: () => content,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  const content = {
    querySelector: () => spacerNode,
    querySelectorAll: () => items,
  }
  globalThis.window = { matchMedia: () => ({ matches: reducedMotion }), addEventListener() {}, removeEventListener() {} }
  globalThis.performance = { now: () => now }
  globalThis.getComputedStyle = (node) => node === content ? { paddingBottom: '24px', rowGap: '72px' } : { scrollPaddingTop: '64px' }
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {} unobserve() {} disconnect() {}
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  const motion = attachConversationScrollMotion(scroll)
  const spacer = attachConversationSpacer(scroll, motion)
  const add = (id, height = 96) => {
    const node = {
      dataset: { turnId: id }, offsetHeight: height,
      position() { return 60 + items.slice(0, items.indexOf(node)).reduce((sum, item) => sum + item.offsetHeight + 72, 0) },
      getBoundingClientRect() { return { top: 16 + this.position() - scroll.scrollTop } },
    }
    items.push(node)
    return node
  }
  const frame = (elapsed = 16) => {
    now += elapsed
    const queued = [...frames.values()]
    frames.clear()
    queued.forEach((callback) => callback(now))
  }
  return {
    scroll, spacer, items, add, frame,
    get height() { return spacerHeight() },
    send(id, height) { const item = add(id, height); spacer.acceptTurn(id); spacer.measure(); return item },
    userScroll(value) { spacer.scrollIntent(); scroll.scrollTop = value; listeners.get('scroll')?.() },
    resize() { observers.forEach((observer) => observer.callback()); frame() },
    restore() { spacer.dispose(); motion.dispose(); Object.assign(globalThis, originals) },
  }
}

test('send creates scroll reach even when several messages fit inside the min-height container', () => {
  const f = fixture()
  try {
    for (let index = 1; index <= 4; index++) {
      const item = f.send(String(index))
      assert.equal(item.position() - f.scroll.scrollTop, index === 1 ? 60 : 64)
      assert.equal(f.height, 900 - (index === 1 ? 60 : 64) - 96 - 24)
    }
  } finally { f.restore() }
})

test('reply growth consumes spacer without moving the viewport or restoring it on shrink', () => {
  const f = fixture()
  try {
    f.send('old')
    const current = f.send('new')
    const top = f.scroll.scrollTop
    const height = f.height
    current.offsetHeight += 150
    f.spacer.measure()
    assert.equal(f.height, height - 150)
    assert.equal(f.scroll.scrollTop, top)
    current.offsetHeight -= 60
    f.spacer.measure()
    assert.equal(f.height, height - 150)
    current.offsetHeight += 30
    f.spacer.measure()
    assert.equal(f.height, height - 150)
    current.offsetHeight += 1000
    f.spacer.measure()
    assert.equal(f.height, 0)
    assert.equal(f.scroll.scrollTop, top)
  } finally { f.restore() }
})

test('upward reader scroll consumes visible spacer and downward scroll does not restore it', () => {
  const f = fixture()
  try {
    f.send('one'); f.send('two'); f.send('three')
    const initial = f.height
    const top = f.scroll.scrollTop
    f.userScroll(top - 80)
    assert.equal(f.height, initial - 80)
    f.userScroll(f.scroll.scrollTop + 50)
    assert.equal(f.height, initial - 80)
    f.userScroll(0)
    assert.ok(f.height < initial - 80)
  } finally { f.restore() }
})

test('spacer completely outside the viewport is removed and only a new send can recreate it', () => {
  const f = fixture()
  try {
    for (let index = 0; index < 8; index++) f.send(String(index))
    f.userScroll(0)
    assert.equal(f.height, 0)
    f.spacer.measure()
    assert.equal(f.height, 0)
    f.userScroll(300)
    assert.equal(f.height, 0)
    f.send('new')
    assert.equal(f.height, 900 - 64 - 96 - 24)
  } finally { f.restore() }
})

test('a new send reuses the remainder and allocates only the required total, without accumulation', () => {
  const f = fixture()
  try {
    const first = f.send('one')
    first.offsetHeight += 200
    f.spacer.measure()
    const remainder = f.height
    f.send('two')
    const required = 900 - 64 - 96 - 24
    assert.ok(remainder < required)
    assert.equal(f.height, required)
    f.send('three')
    assert.equal(f.height, required)
  } finally { f.restore() }
})

test('send motion reserves spacer immediately, then streaming resize never starts another scroll', () => {
  const f = fixture(false)
  try {
    f.add('one')
    const turn = f.send('two')
    assert.ok(f.height > 0)
    assert.equal(f.scroll.scrollTop, 0)
    f.frame(100)
    assert.ok(f.scroll.scrollTop > 0 && f.scroll.scrollTop < turn.position() - 64)
    f.frame(400)
    assert.equal(f.scroll.scrollTop, turn.position() - 64)
    const top = f.scroll.scrollTop
    turn.offsetHeight += 120
    f.resize()
    f.frame(400)
    assert.equal(f.scroll.scrollTop, top)
  } finally { f.restore() }
})

test('reader intent interrupts send alignment and prevents later resize from realigning', () => {
  const f = fixture(false)
  try {
    f.add('one'); const current = f.send('two')
    f.frame(100)
    f.userScroll(0)
    current.offsetHeight += 30
    f.resize()
    f.frame(500)
    assert.equal(f.scroll.scrollTop, 0)
  } finally { f.restore() }
})

test('composer collapse can add send reach during alignment, then later resizes cannot refill it', () => {
  const f = fixture(false)
  try {
    f.add('one'); const current = f.send('two')
    const initial = f.height
    f.scroll.clientHeight += 100
    f.frame(100)
    assert.equal(f.height, initial + 100)
    f.frame(400)
    assert.equal(f.scroll.scrollTop, current.position() - 64)
    f.userScroll(0)
    const consumed = f.height
    f.scroll.clientHeight += 100
    f.resize()
    assert.equal(f.height, consumed)
  } finally { f.restore() }
})

test('retry resets the response growth baseline without recreating consumed spacer', () => {
  const f = fixture()
  try {
    f.send('one'); const current = f.send('two')
    current.offsetHeight += 150
    f.spacer.measure()
    const remaining = f.height
    current.offsetHeight -= 150
    f.spacer.retryTurn()
    f.spacer.measure()
    assert.equal(f.height, remaining)
    current.offsetHeight += 50
    f.spacer.measure()
    assert.equal(f.height, remaining - 50)
  } finally { f.restore() }
})

test('manual jump targets the real answer end instead of the blank spacer', () => {
  const f = fixture()
  try {
    f.send('one'); f.send('two'); const latest = f.send('three')
    latest.offsetHeight += 500
    f.spacer.measure()
    const end = latest.position() + latest.offsetHeight + 24
    f.spacer.jumpToLatest()
    assert.equal(f.scroll.scrollTop, Math.max(0, end - f.scroll.clientHeight + 16))
    assert.ok(f.height <= 16)
  } finally { f.restore() }
})
