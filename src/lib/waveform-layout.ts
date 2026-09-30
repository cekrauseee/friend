/** Center the complete bar group without including a trailing gap. */
export function waveformLayout(width: number, barWidth: number, barGap: number) {
  const step = barWidth + barGap
  const count = Math.max(0, Math.floor((width + barGap) / step))
  const drawnWidth = Math.max(0, count * step - barGap)
  return { count, step, startX: (width - drawnWidth) / 2 }
}
