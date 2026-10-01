// Adapted from Nexvyn Blossom Picker: https://ui.nexvyn.dev/r/color-picker.json
// Copyright (c) 2026 Nexvyn UI. MIT with Commons Clause; see THIRD_PARTY_NOTICES.md.
export interface BlossomColorPickerValue {
  hue: number
  saturation: number
  lightness?: number
  originalSaturation?: number
  alpha: number
  layer: 'inner' | 'outer'
}

export interface BlossomColorPickerColor extends BlossomColorPickerValue {
  hex: string
  hsl: string
  hsla: string
  rgb: string
  rgba: string
  r: number
  g: number
  b: number
}

export type ColorInput =
  | string
  | {
      h: number
      s: number
      l: number
    }

export type SliderPosition = 'top' | 'bottom' | 'left' | 'right'
