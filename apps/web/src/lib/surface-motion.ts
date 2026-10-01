// Surface entrances share a restrained spring; geometry morphs stay separate.
export const surfaceHidden = { opacity: 0, y: 8, scale: 0.96 }
export const surfaceVisible = { opacity: 1, y: 0, scale: 1 }
export const surfaceExit = { opacity: 0, y: 4, scale: 0.98 }
export const surfaceFade = { duration: 0.14, ease: 'easeOut' } as const
export const surfaceSpring = {
  type: 'spring', duration: 0.28, bounce: 0.12,
  opacity: surfaceFade,
  filter: surfaceFade,
} as const
