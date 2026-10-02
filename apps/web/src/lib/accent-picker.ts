import type { BlossomColorPickerValue } from '../components/ui/blossom picker/types.ts'
import { hexToHsl, lightnessToSliderValue } from '../components/ui/blossom picker/utils.ts'

/** The supplied arc controls shade; alpha remains opaque. */
export function accentPickerValue(seed: string | null): BlossomColorPickerValue {
  const { h, s, l } = hexToHsl(seed ?? '#a3a3a3')
  const shade = lightnessToSliderValue(l)
  return { hue: h, saturation: shade, originalSaturation: s, lightness: l, alpha: 100, layer: l > 80 ? 'inner' : 'outer' }
}
