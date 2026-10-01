import assert from 'node:assert/strict'
import test from 'node:test'
import { accentPreference, accentStorageKey, createAccentPreference } from '../src/lib/accent-preference.ts'
import { parseAccentSeed, resolveAccentPalette } from '../src/lib/accent-color.ts'

const saved = (seed, version = 1) => JSON.stringify({ version, seed })

function fixture({ initial = null, dark = false, blocked = false, preexisting = {} } = {}) {
  const values = new Map(initial === null ? [] : [[accentStorageKey, initial]])
  const css = new Map(Object.entries(preexisting).map(([key, value]) => [key, { value, priority: 'important' }]))
  const writes = []
  const storage = {
    getItem(key) { if (blocked) throw new Error('Blocked'); return values.get(key) ?? null },
    setItem(key, value) { if (blocked) throw new Error('Blocked'); values.set(key, value); writes.push(key) },
    removeItem(key) { if (blocked) throw new Error('Blocked'); values.delete(key); writes.push(key) },
  }
  const style = {
    getPropertyValue: (key) => css.get(key)?.value ?? '',
    getPropertyPriority: (key) => css.get(key)?.priority ?? '',
    setProperty: (key, value, priority = '') => css.set(key, { value, priority }),
    removeProperty: (key) => css.delete(key),
  }
  const events = new EventTarget()
  const media = Object.assign(new EventTarget(), { matches: dark })
  const store = createAccentPreference({ storage, style, events, media })
  const storageEvent = (key, newValue, storageArea = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, storageArea }))
  const appearance = (matches) => { media.matches = matches; media.dispatchEvent(Object.assign(new Event('change'), { matches })) }
  return { store, css, style, storage, values, writes, storageEvent, appearance }
}

test('saved preference is applied synchronously and snapshots remain stable until a real change', () => {
  const f = fixture({ initial: saved('#abc'), dark: true })
  const snapshot = f.store.getSnapshot()
  assert.equal(snapshot.seed, '#aabbcc')
  assert.equal(snapshot.appearance, 'dark')
  assert.deepEqual(snapshot.palette, resolveAccentPalette(parseAccentSeed('#abc'), 'dark'))
  assert.equal(f.css.get('--primary').value, snapshot.palette.primary)
  assert.equal(f.store.getSnapshot(), snapshot)
  assert.equal(f.writes.length, 0)
  let notifications = 0
  const unsubscribe = f.store.subscribe(() => {
    notifications++
    assert.equal(f.css.get('--primary').value, f.store.getSnapshot().palette.primary)
  })
  f.store.setSeed('#aabbcc')
  f.appearance(true)
  assert.equal(f.store.getSnapshot(), snapshot)
  assert.equal(notifications, 0)
  f.store.setSeed('#f00')
  assert.equal(notifications, 1)
  unsubscribe()
  f.store.setSeed('#0f0')
  assert.equal(notifications, 1)
  assert.deepEqual(JSON.parse(f.values.get(accentStorageKey)), { version: 1, seed: '#00ff00' })
  f.store.dispose()
})

test('invalid or stale storage stays neutral and invalid changes preserve a valid preference', () => {
  for (const initial of ['broken', saved('#f008'), saved('#abc', 2), 'null', '42', '{}', JSON.stringify({ seed: '#abc' })]) {
    const f = fixture({ initial })
    assert.equal(f.store.getSnapshot().seed, null)
    assert.equal(f.css.size, 0)
    assert.equal(f.store.setSeed('#663399'), true)
    const before = f.store.getSnapshot()
    assert.equal(f.store.setSeed('transparent'), false)
    assert.equal(f.store.getSnapshot(), before)
    f.store.dispose()
  }
})

test('storage failures allow memory-only selection, appearance changes and reset', () => {
  const f = fixture({ blocked: true })
  assert.equal(f.store.setSeed('#f00'), true)
  assert.equal(f.store.getSnapshot().seed, '#ff0000')
  f.appearance(true)
  assert.equal(f.store.getSnapshot().appearance, 'dark')
  assert.equal(f.css.get('--primary').value, f.store.getSnapshot().palette.primary)
  const reset = f.store.reset
  reset()
  assert.equal(f.store.getSnapshot().palette, null)
  assert.equal(f.css.size, 0)
  f.store.dispose()
})

test('system changes derive from the canonical seed without cumulative conversion drift', () => {
  const f = fixture({ initial: saved('#f1b437') })
  const light = f.store.getSnapshot().palette
  f.appearance(true)
  const dark = f.store.getSnapshot().palette
  assert.notEqual(light.primary, dark.primary)
  for (let i = 0; i < 10; i++) {
    f.appearance(false)
    assert.deepEqual(f.store.getSnapshot().palette, light)
    f.appearance(true)
    assert.deepEqual(f.store.getSnapshot().palette, dark)
  }
  assert.equal(f.store.getSnapshot().seed, '#f1b437')
  assert.equal(f.writes.length, 0)
  f.store.dispose()
})

test('user Bubble roles apply before notification, follow theme and cross-tab seed, and clear on neutral reset', () => {
  const f = fixture({ initial: saved('#ff8800') })
  const roles = {
    '--selection': 'selection', '--selection-foreground': 'selectionForeground',
    '--user-bubble': 'userBubble', '--user-bubble-foreground': 'userBubbleForeground',
    '--user-bubble-selection': 'selection', '--user-bubble-selection-foreground': 'selectionForeground',
  }
  const applied = () => {
    for (const [token, role] of Object.entries(roles)) assert.equal(f.css.get(token)?.value, f.store.getSnapshot().palette[role])
  }
  applied()
  const stop = f.store.subscribe(applied)
  f.appearance(true)
  f.store.setSeed('#443399')
  f.storageEvent(accentStorageKey, saved('#88ee44'))
  stop()
  f.store.reset()
  for (const token of Object.keys(roles)) assert.equal(f.css.has(token), false)
  f.store.setSeed('#f00')
  applied()
  f.store.dispose()
  for (const token of Object.keys(roles)) assert.equal(f.css.has(token), false)
})

test('cross-tab storage events update without echoing, and ignore unrelated keys and storage areas', () => {
  const f = fixture()
  f.storageEvent('other', saved('#abc'))
  f.storageEvent(accentStorageKey, saved('#abc'), {})
  assert.equal(f.store.getSnapshot().seed, null)
  f.storageEvent(accentStorageKey, saved('#abc'))
  assert.equal(f.store.getSnapshot().seed, '#aabbcc')
  assert.equal(f.writes.length, 0)
  f.storageEvent(accentStorageKey, null)
  assert.equal(f.store.getSnapshot().palette, null)
  f.storageEvent(accentStorageKey, saved('#f00'))
  f.storageEvent(null, null)
  assert.equal(f.css.size, 0)
  f.storageEvent(accentStorageKey, saved('#00f'))
  f.storageEvent(accentStorageKey, saved('#0f0', 10))
  assert.equal(f.store.getSnapshot().seed, null)
  f.store.dispose()
})

test('reset and disposal restore existing inline roles and preserve unrelated or later overrides', () => {
  const f = fixture({ preexisting: { '--primary': 'previous primary', '--destructive': 'red', '--accent': 'neutral' } })
  f.store.setSeed('#123456')
  f.store.setSeed('#abcdef')
  f.store.reset()
  assert.deepEqual(f.css.get('--primary'), { value: 'previous primary', priority: 'important' })
  assert.equal(f.css.has('--primary-foreground'), false)
  assert.equal(f.css.has('--ring'), false)
  assert.equal(f.values.has(accentStorageKey), false)
  f.store.setSeed('#ff00ff')
  f.style.setProperty('--ring', 'later override')
  const before = f.store.getSnapshot()
  let calls = 0
  f.store.subscribe(() => calls++)
  f.store.dispose()
  f.store.dispose()
  f.storageEvent(accentStorageKey, saved('#00f'))
  f.appearance(true)
  assert.equal(f.store.setSeed('#fff'), false)
  assert.equal(f.store.getSnapshot(), before)
  assert.equal(calls, 0)
  assert.equal(f.css.get('--ring').value, 'later override')
  assert.equal(f.css.get('--accent').value, 'neutral')
  assert.equal(f.css.get('--destructive').value, 'red')
  assert.deepEqual(f.css.get('--primary'), { value: 'previous primary', priority: 'important' })
})

test('server rendering has a stable neutral snapshot without browser globals', () => {
  assert.equal(accentPreference.getSnapshot().palette, null)
  assert.equal(accentPreference.getServerSnapshot(), accentPreference.getServerSnapshot())
  assert.deepEqual(accentPreference.getServerSnapshot(), { seed: null, appearance: 'light', palette: null })
})
