interface TextRect {
  left: number
  right: number
  top: number
  height: number
}

interface OrbRect {
  left: number
  top: number
  width: number
  height: number
}

export function inlineOrbPosition(text: TextRect, home: OrbRect, rtl = false, gap = 8) {
  return {
    x: (rtl ? text.left - home.width - gap : text.right + gap) - home.left,
    y: text.top + (text.height - home.height) / 2 - home.top,
  }
}
