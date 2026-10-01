import { useCallback, useId, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BlossomPicker, type BlossomPickerColor, type BlossomPickerValue } from '@/components/ui/color-picker-standalone'
import { useAccentPreference } from '@/hooks/use-accent-preference'
import { accentPreference } from '@/lib/accent-preference'
import { accentPickerValue } from '@/lib/accent-picker'
import { interfaceSounds } from '@/lib/interface-sounds'
import { surfaceFade, surfaceHidden, surfaceSpring, surfaceVisible } from '@/lib/surface-motion'

export function AccentPicker() {
  const { seed, palette } = useAccentPreference()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<{ seed: string | null; value: BlossomPickerValue }>(() => ({ seed, value: accentPickerValue(seed) }))
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const title = useId()
  const description = useId()
  const reducedMotion = useReducedMotion() || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const value = selection.seed === seed ? selection.value : accentPickerValue(seed)
  const select = useCallback((color: BlossomPickerColor) => {
    if (open && accentPreference.setSeed(color.hex)) setSelection({ seed: color.hex.toLowerCase(), value: color })
  }, [open])
  const changeOpen = (next: boolean) => {
    if (next && !open) interfaceSounds.play('accentOpen', true)
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button ref={trigger} type="button" variant="ghost" size="icon-lg" className="accent-trigger"
          data-appearance-control aria-label="Accent color" title="Accent color">
          <span aria-hidden="true" className="accent-swatch" style={{ backgroundColor: palette?.primary ?? 'var(--primary)' }} />
        </Button>
      </PopoverTrigger>
      <PopoverContent ref={content} side="bottom" align="end" sideOffset={8} collisionPadding={16}
        className="accent-popover" inert={!open} aria-hidden={!open || undefined} data-appearance-control aria-labelledby={title} aria-describedby={description}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          content.current?.querySelector<HTMLButtonElement>('.bcp-petal[tabindex="0"]')?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }}>
        <motion.div initial={reducedMotion ? { opacity: 0 } : surfaceHidden} animate={surfaceVisible}
          transition={reducedMotion ? surfaceFade : surfaceSpring} className="accent-picker-content">
          <div className="accent-picker-heading">
            <h2 id={title}>Accent color</h2>
            <p id={description}>Choose a color. Adjust its shade with the arc.</p>
          </div>
          <div className="accent-picker-stage">
            <BlossomPicker variant="blossom-arc" value={value} onChange={select} initialExpanded collapsible={false}
              disabled={!open} openOnHover={false} adaptivePositioning={false} sliderPosition="right" coreSize={32} petalSize={32}
              circularBarWidth={12} sliderWidth={12} sliderOffset={22} animationDuration={280} />
          </div>
          <div className="accent-picker-footer">
            <span className="accent-picker-preview" aria-live="polite">{seed ? seed.toUpperCase() : 'Neutral'}</span>
            <Button type="button" variant="ghost" size="sm" disabled={!seed || !open} onClick={() => {
              if (!open) return
              accentPreference.reset()
              setSelection({ seed: null, value: accentPickerValue(null) })
              interfaceSounds.play('accentReset', true)
            }}>Restore neutral</Button>
          </div>
        </motion.div>
      </PopoverContent>
    </Popover>
  )
}
