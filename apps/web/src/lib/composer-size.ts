export function composerSize(contentHeight: number, lineHeight: number, padding: number, maxHeight = 192, compactContentHeight = contentHeight) {
  const singleLineHeight = Math.max(36, Math.ceil(lineHeight + padding))
  return {
    height: Math.min(maxHeight, Math.max(singleLineHeight, contentHeight)),
    expanded: compactContentHeight > singleLineHeight + 1,
    scrollable: contentHeight > maxHeight,
  }
}

export const composerMorph = { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] as const }
