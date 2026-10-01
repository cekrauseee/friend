import { parseAccentSeed, resolveAccentPalette, type AccentAppearance, type AccentPalette, type AccentSeed } from './accent-color.ts'

export const accentStorageKey = 'dot:accent-color'
export interface AccentSnapshot {
  readonly seed: AccentSeed | null
  readonly appearance: AccentAppearance
  readonly palette: AccentPalette | null
}

interface AccentEnvironment {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  media?: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  style?: Pick<CSSStyleDeclaration, 'getPropertyValue' | 'getPropertyPriority' | 'setProperty' | 'removeProperty'>
}

const neutralSnapshot: AccentSnapshot = { seed: null, appearance: 'light', palette: null }
const tokenRoles = {
  '--primary': 'primary', '--primary-foreground': 'primaryForeground', '--ring': 'ring',
  '--selection': 'selection', '--selection-foreground': 'selectionForeground',
  '--user-bubble': 'userBubble', '--user-bubble-foreground': 'userBubbleForeground',
  '--user-bubble-selection': 'selection', '--user-bubble-selection-foreground': 'selectionForeground',
} as const

function storedSeed(value: string | null): AccentSeed | null {
  if (!value) return null
  try {
    const saved: unknown = JSON.parse(value)
    if (saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 && 'seed' in saved) return parseAccentSeed(saved.seed)
  } catch { /* Invalid or obsolete data restores the neutral appearance. */ }
  return null
}

export function createAccentPreference({ storage, media, events, style }: AccentEnvironment = {}) {
  let seed: AccentSeed | null = null
  try { seed = storedSeed(storage?.getItem(accentStorageKey) ?? null) } catch { /* Use memory when storage is unavailable. */ }
  let snapshot: AccentSnapshot = { seed, appearance: media?.matches ? 'dark' : 'light', palette: null }
  const listeners = new Set<() => void>()
  const owned = new Map<string, { previous: string; priority: string; applied: string }>()
  let disposed = false

  const clearTokens = () => {
    for (const [token, { previous, priority, applied }] of owned) {
      // Do not remove another owner's later inline change.
      if (style?.getPropertyValue(token) !== applied) continue
      if (previous) style.setProperty(token, previous, priority)
      else style.removeProperty(token)
    }
    owned.clear()
  }
  const applyTokens = () => {
    if (!style) return
    if (!snapshot.palette) { clearTokens(); return }
    for (const [token, role] of Object.entries(tokenRoles)) {
      const applied = snapshot.palette[role]
      const previous = owned.get(token) ?? { previous: style.getPropertyValue(token), priority: style.getPropertyPriority(token), applied }
      owned.set(token, { ...previous, applied })
      style.setProperty(token, applied)
    }
  }
  const update = (nextSeed: AccentSeed | null, appearance = snapshot.appearance) => {
    if (disposed || (nextSeed === snapshot.seed && appearance === snapshot.appearance)) return
    snapshot = { seed: nextSeed, appearance, palette: resolveAccentPalette(nextSeed, appearance) }
    applyTokens()
    listeners.forEach((listener) => listener())
  }
  const onStorage = (event: StorageEvent) => {
    if ((event.key !== accentStorageKey && event.key !== null) || (event.storageArea && event.storageArea !== storage)) return
    update(event.key === null ? null : storedSeed(event.newValue))
  }
  const onAppearance = (event: MediaQueryListEvent) => update(snapshot.seed, event.matches ? 'dark' : 'light')
  const setSeed = (value: string | null) => {
    if (disposed) return false
    const next = value === null ? null : parseAccentSeed(value)
    if (value !== null && next === null) return false
    update(next)
    try {
      if (next === null) storage?.removeItem(accentStorageKey)
      else storage?.setItem(accentStorageKey, JSON.stringify({ version: 1, seed: next }))
    } catch { /* Live changes remain usable in memory. */ }
    return true
  }
  // Hydrate and apply synchronously before any subscribed React component renders.
  snapshot = { ...snapshot, palette: resolveAccentPalette(seed, snapshot.appearance) }
  applyTokens()
  events?.addEventListener('storage', onStorage)
  media?.addEventListener('change', onAppearance)

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => neutralSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setSeed,
    reset: () => setSeed(null),
    dispose() {
      if (disposed) return
      disposed = true
      events?.removeEventListener('storage', onStorage)
      media?.removeEventListener('change', onAppearance)
      clearTokens()
      listeners.clear()
    },
  }
}

function browserEnvironment(): AccentEnvironment {
  if (typeof window === 'undefined') return {}
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Storage access can be blocked independently of the theme. */ }
  return { storage, media: window.matchMedia('(prefers-color-scheme: dark)'), events: window, style: document.documentElement.style }
}

export const accentPreference = createAccentPreference(browserEnvironment())
if (import.meta.hot) import.meta.hot.dispose(() => accentPreference.dispose())
