import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { parseAccentSeed, resolveAccentPalette } from '../src/lib/accent-color.ts'

const seeds = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffcbd7', '#d8eaff', '#08031a', '#fcfff6', '#000000', '#ffffff', '#808080', '#663399']

// Measure the serialized CSS that consumers actually receive, not internal L estimates.
function cssLinear(css) {
  const [l, c, h] = css.match(/[\d.]+/g).map(Number)
  const a = c * Math.cos(h * Math.PI / 180)
  const b = c * Math.sin(h * Math.PI / 180)
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * ll - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * ll + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * ll - 0.7034186147 * m + 1.707614701 * s]
}

function luminance(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] }
function contrast(first, second) {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('opaque seeds canonicalize hex and reject transparent, malformed and non-string input', () => {
  assert.equal(parseAccentSeed(' #AbC '), '#aabbcc')
  assert.equal(parseAccentSeed('#123f'), '#112233')
  assert.equal(parseAccentSeed('#aabbccff'), '#aabbcc')
  for (const value of [null, {}, 42, '', '#1234', '#aabbcc00', 'red', 'rgb(1,2,3)', '#abcdex', '#ab']) assert.equal(parseAccentSeed(value), null)
  assert.equal(resolveAccentPalette(null, 'dark'), null)
  assert.throws(() => resolveAccentPalette('invalid', 'light'), TypeError)
})

test('primary text, links and opaque focus roles meet contrast on current appearance surfaces', () => {
  for (const seed of seeds) for (const appearance of ['light', 'dark']) {
    const palette = resolveAccentPalette(parseAccentSeed(seed), appearance)
    const primary = cssLinear(palette.primary)
    const foreground = cssLinear(palette.primaryForeground)
    assert.ok(contrast(primary, foreground) >= 4.5, `${seed} ${appearance}: primary foreground`)
    const surfaces = appearance === 'light' ? [1, 0.985, 0.97] : [0.145, 0.205, 0.269]
    for (const l of surfaces) {
      const surface = cssLinear(`oklch(${l} 0 0)`)
      assert.ok(contrast(primary, surface) >= 4.5, `${seed} ${appearance}: primary on L=${l}`)
      assert.ok(contrast(cssLinear(palette.ring), surface) >= 3, `${seed} ${appearance}: opaque focus on L=${l}`)
    }
  }
})

test('serialized colors stay finite and in sRGB across representative seeds and the RGB cube', () => {
  const samples = [...seeds]
  for (const r of [0, 64, 128, 192, 255]) for (const g of [0, 64, 128, 192, 255]) for (const b of [0, 64, 128, 192, 255]) {
    samples.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`)
  }
  for (const seed of samples) for (const appearance of ['light', 'dark']) {
    const palette = resolveAccentPalette(parseAccentSeed(seed), appearance)
    for (const color of [palette.primary, palette.primaryForeground, palette.ring, palette.userBubble, palette.userBubbleForeground, palette.selection, palette.selectionForeground]) {
      for (const channel of cssLinear(color)) assert.ok(Number.isFinite(channel) && channel >= -1e-7 && channel <= 1 + 1e-7, `${seed} ${appearance}: ${color}`)
    }
    assert.ok(contrast(cssLinear(palette.userBubble), cssLinear(palette.userBubbleForeground)) >= 7, `${seed} ${appearance}: message text`)
    assert.ok(contrast(cssLinear(palette.selection), cssLinear(palette.selectionForeground)) >= 7, `${seed} ${appearance}: selected text`)
    assert.ok(contrast(cssLinear(palette.selection), cssLinear(palette.userBubble)) >= 3, `${seed} ${appearance}: highlight distinction`)
    for (const pair of [palette.orb, ...Object.values(palette.orbStates)]) {
      assert.match(pair.ink, /^#[\da-f]{6}$/)
      assert.match(pair.paper, /^#[\da-f]{6}$/)
    }
  }
})

test('blue and violet messages use their own readable tones instead of the primary-control foreground', () => {
  for (const seed of ['#3b82f6', '#8b5cf6']) {
    const dark = resolveAccentPalette(parseAccentSeed(seed), 'dark')
    const light = resolveAccentPalette(parseAccentSeed(seed), 'light')
    assert.equal(dark.primaryForeground, 'oklch(0 0 0)', 'existing primary-control behavior stays intact')
    assert.equal(dark.userBubbleForeground, 'oklch(1 0 0)')
    assert.equal(light.userBubbleForeground, 'oklch(0 0 0)')
    assert.notEqual(dark.userBubble, dark.primary)
    assert.ok(contrast(cssLinear(dark.userBubble), cssLinear(dark.userBubbleForeground)) >= 7)
    assert.ok(contrast(cssLinear(dark.selection), cssLinear(dark.selectionForeground)) >= 7)
    assert.ok(contrast(cssLinear(dark.selection), cssLinear(dark.userBubble)) >= 3)
  }
})

test('user Bubble text stays black or white and its selection retains the selected color family', () => {
  for (const seed of seeds) for (const appearance of ['light', 'dark']) {
    const palette = resolveAccentPalette(parseAccentSeed(seed), appearance)
    for (const foreground of [palette.userBubbleForeground, palette.selectionForeground]) assert.ok(['oklch(0 0 0)', 'oklch(1 0 0)'].includes(foreground))
    assert.ok(contrast(cssLinear(palette.userBubble), cssLinear(palette.userBubbleForeground)) >= 7)
    assert.ok(contrast(cssLinear(palette.selection), cssLinear(palette.selectionForeground)) >= 7)
    assert.ok(contrast(cssLinear(palette.selection), cssLinear(palette.userBubble)) >= 3)
    const [, primaryChroma, primaryHue] = palette.primary.match(/[\d.]+/g).map(Number)
    const [, selectionChroma, selectionHue] = palette.selection.match(/[\d.]+/g).map(Number)
    if (primaryChroma && selectionChroma) assert.equal(selectionHue, primaryHue)
    if (['#000000', '#ffffff', '#808080'].includes(seed)) assert.equal(selectionChroma, 0)
  }
})

test('neutral user Bubble preserves secondary fills with black or white text and distinct readable selection', async () => {
  const source = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const rootStart = source.indexOf(':root {')
  const darkStart = source.indexOf('@media (prefers-color-scheme: dark)', rootStart)
  const light = source.slice(rootStart, darkStart)
  const dark = source.slice(darkStart, source.indexOf('@theme inline'))
  const token = (block, name) => block.match(new RegExp(`--${name}:\\s*([^;]+);`))[1]
  assert.equal(token(light, 'user-bubble'), 'var(--secondary)')
  assert.equal(token(light, 'user-bubble-selection'), 'var(--selection)')
  for (const block of [light, dark]) {
    const fill = token(block, 'secondary')
    const foreground = token(block, 'user-bubble-foreground')
    const selection = token(block, 'primary')
    const selectionForeground = token(block, 'user-bubble-selection-foreground')
    assert.ok(['oklch(0 0 0)', 'oklch(1 0 0)'].includes(foreground))
    assert.ok(['oklch(0 0 0)', 'oklch(1 0 0)'].includes(selectionForeground))
    assert.ok(contrast(cssLinear(fill), cssLinear(foreground)) >= 7)
    assert.ok(contrast(cssLinear(selection), cssLinear(selectionForeground)) >= 7)
    assert.ok(contrast(cssLinear(fill), cssLinear(selection)) >= 3)
  }
})

test('color identity and available shade intent survive appearance resolution without tinting grays', () => {
  // Reference red OKLCH hue is about 29.234 degrees; it must not become pink or purple.
  for (const appearance of ['light', 'dark']) {
    const red = resolveAccentPalette(parseAccentSeed('#ff0000'), appearance)
    assert.ok(Math.abs(Number(red.primary.match(/[\d.]+/g)[2]) - 29.234) < 0.01)
    for (const seed of ['#000000', '#ffffff', '#808080']) {
      const gray = resolveAccentPalette(parseAccentSeed(seed), appearance)
      assert.match(gray.primary, /^oklch\([\d.]+ 0 0\)$/)
      for (const pair of Object.values(gray.orbStates)) {
        for (const color of Object.values(pair)) assert.equal(color.slice(1, 3), color.slice(3, 5))
      }
    }
  }
  // Two already usable shades remain distinct rather than collapsing to a fixed ramp step.
  assert.notEqual(resolveAccentPalette(parseAccentSeed('#40151c'), 'light').primary, resolveAccentPalette(parseAccentSeed('#752736'), 'light').primary)
  assert.notEqual(resolveAccentPalette(parseAccentSeed('#ffaabb'), 'dark').primary, resolveAccentPalette(parseAccentSeed('#ffddee'), 'dark').primary)
  const palette = resolveAccentPalette(parseAccentSeed('#663399'), 'dark')
  assert.deepEqual(palette.orbStates.idle, palette.orb)
  assert.notDeepEqual(palette.orbStates.thinking, palette.orbStates.speaking)
})
