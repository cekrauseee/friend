declare const accentSeedBrand: unique symbol

/** Canonical opaque sRGB hex, independent of the currently rendered appearance. */
export type AccentSeed = string & { readonly [accentSeedBrand]: true }
export type AccentAppearance = 'light' | 'dark'
export type OrbAccentColors = { readonly ink: string; readonly paper: string }
export interface AccentPalette {
  readonly primary: string
  readonly primaryForeground: string
  readonly ring: string
  readonly userBubble: string
  readonly userBubbleForeground: string
  readonly selection: string
  readonly selectionForeground: string
  readonly orb: OrbAccentColors
  readonly orbStates: Readonly<Record<'idle' | 'thinking' | 'speaking', OrbAccentColors>>
}

type Oklch = { l: number; c: number; h: number }
type Rgb = [number, number, number]

export function parseAccentSeed(value: unknown): AccentSeed | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().toLowerCase()
  if (/^#[\da-f]{3}$/.test(hex)) return `#${hex.slice(1).split('').map((channel) => channel.repeat(2)).join('')}` as AccentSeed
  if (/^#[\da-f]{6}$/.test(hex)) return hex as AccentSeed
  // Accept alpha notation only when it is fully opaque.
  if (/^#[\da-f]{3}f$/.test(hex)) return parseAccentSeed(hex.slice(0, 4))
  if (/^#[\da-f]{6}ff$/.test(hex)) return parseAccentSeed(hex.slice(0, 7))
  return null
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const round = (value: number) => Math.round(value * 1000) / 1000
const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const encoded = (channel: number) => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
const hexRgb = (hex: string): Rgb => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as Rgb

// Combined sRGB/D65/Oklab matrices; conversion conventions: https://www.w3.org/TR/css-color-4/#color-conversion-code
function seedOklch(seed: AccentSeed): Oklch {
  const [r, g, b] = hexRgb(seed).map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const c = Math.hypot(a, bb)
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: c < 0.00001 ? 0 : c, h: c < 0.00001 ? 0 : (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 }
}

function linearRgb({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos(h * Math.PI / 180)
  const b = c * Math.sin(h * Math.PI / 180)
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * ll - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * ll + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * ll - 0.7034186147 * m + 1.707614701 * s]
}

function inGamut(color: Oklch) {
  return linearRgb(color).every((channel) => channel >= -1e-7 && channel <= 1 + 1e-7)
}

/** Quantize before checking gamut, so emitted CSS does not round out of sRGB. */
function gamutColor(l: number, c: number, h: number): Oklch {
  const color = { l: round(clamp(l)), c: round(Math.max(0, c)), h: round((h + 360) % 360) }
  let low = 0
  let high = color.c
  if (!inGamut(color)) {
    for (let i = 0; i < 20; i++) {
      const middle = (low + high) / 2
      if (inGamut({ ...color, c: middle })) low = middle
      else high = middle
    }
    color.c = Math.floor(low * 1000) / 1000
  }
  if (color.c === 0) color.h = 0
  return color
}

function luminance(color: Oklch) {
  const [r, g, b] = linearRgb(color).map((channel) => clamp(channel))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Oklch, b: Oklch) {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function blackOrWhite(color: Oklch): Oklch {
  const white = { l: 1, c: 0, h: 0 }
  const black = { l: 0, c: 0, h: 0 }
  return contrast(color, white) >= contrast(color, black) ? white : black
}

/** Message tones have a stricter text budget than short primary controls. */
function readableTone(color: Oklch, foreground: Oklch, direction: -1 | 1, distinctFrom?: Oklch): Oklch {
  let tone = gamutColor(color.l, color.c, color.h)
  for (let i = 0; i < 1000; i++) {
    if (contrast(tone, foreground) >= 7 && (!distinctFrom || contrast(tone, distinctFrom) >= 3)) break
    tone = gamutColor(tone.l + direction * 0.001, color.c, color.h)
  }
  return tone
}

const css = ({ l, c, h }: Oklch) => `oklch(${l} ${c} ${h})`
function hex(color: Oklch) {
  return `#${linearRgb(color).map((channel) => Math.round(clamp(encoded(clamp(channel))) * 255).toString(16).padStart(2, '0')).join('')}`
}

export function resolveAccentPalette(seed: AccentSeed | null, appearance: AccentAppearance): AccentPalette | null {
  if (seed === null) return null
  const valid = parseAccentSeed(seed)
  if (!valid) throw new TypeError('Accent seed must be an opaque hex color.')
  const original = seedOklch(valid)
  // Lowest light surface and highest dark surface currently used by controls in index.css.
  const surface = { l: appearance === 'light' ? 0.97 : 0.269, c: 0, h: 0 }
  let primary = gamutColor(original.l, original.c, original.h)
  // Primary also serves links. Check rendered luminance rather than an OKLCH L estimate.
  for (let i = 0; contrast(primary, surface) < 4.5 && i < 1000; i++) {
    primary = gamutColor(primary.l + (appearance === 'light' ? -0.001 : 0.001), original.c, original.h)
  }
  const foreground = blackOrWhite(primary)
  const light = appearance === 'light'
  const bubbleForeground = { l: light ? 0 : 1, c: 0, h: 0 }
  const bubble = readableTone({
    l: light ? Math.max(0.75, original.l) : Math.min(0.5, original.l),
    c: original.c * 0.65, h: original.h,
  }, bubbleForeground, light ? 1 : -1)
  // Selection has its own opposite tone, so it remains visible inside the Bubble.
  // Use the same readable pair for message prose and editable-field selections.
  const selectionForeground = { l: light ? 1 : 0, c: 0, h: 0 }
  const selection = readableTone({
    l: (light ? 0.28 : 0.84) + original.l * 0.06,
    c: original.c * 0.65, h: original.h,
  }, selectionForeground, light ? -1 : 1, bubble)
  const pair = (lightness: number, shift: number): OrbAccentColors => ({
    ink: hex(gamutColor(0.24 + (original.l - 0.5) * 0.08, original.c * 0.55, original.h + shift)),
    paper: hex(gamutColor(lightness + (original.l - 0.5) * 0.06, original.c * 0.65, original.h + (original.c === 0 ? 0 : shift + 8))),
  })
  const orb = pair(appearance === 'light' ? 0.83 : 0.87, 0)
  return {
    primary: css(primary), primaryForeground: css(foreground), ring: css(primary), orb,
    userBubble: css(bubble), userBubbleForeground: css(bubbleForeground),
    selection: css(selection), selectionForeground: css(selectionForeground),
    orbStates: { idle: orb, thinking: pair(0.8, original.c === 0 ? 0 : -5), speaking: pair(0.89, original.c === 0 ? 0 : 5) },
  }
}
