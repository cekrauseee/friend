export function idleSceneOffsets(height: number, orbHeight: number, footerHeight: number, topInset: number, gap = 24) {
  return {
    composerOffset: (topInset + orbHeight + gap + footerHeight - height) / 2,
    orbOffset: (topInset - orbHeight - gap - footerHeight) / 2,
  }
}
