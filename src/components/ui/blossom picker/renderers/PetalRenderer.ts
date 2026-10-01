// Adapted from Nexvyn Blossom Picker: https://ui.nexvyn.dev/r/color-picker.json
// Copyright (c) 2026 Nexvyn UI. MIT with Commons Clause; see THIRD_PARTY_NOTICES.md.
import { interfaceSounds } from '@/lib/interface-sounds'
import { BLOOM_EASING } from '../constants'
import { createElement, setStyles } from '../dom-helpers'
import { hslToString, hslaToString } from '../utils'

export interface PetalConfig {
  hue: number
  saturation: number
  lightness: number
  index: number
  totalPetals: number
  petalSize: number
  radius: number
  animationDuration: number
  staggerDelay: number
  zIndex: number
  rotationOffset: number
  alpha: number
  clip?: 'left' | 'right'
  pointerEvents: 'auto' | 'none'
  hasShadow: boolean
  noRing?: boolean
}

export class PetalRenderer {
  private onClick?: () => void

  private onMouseEnter?: () => void

  private onMouseLeave?: () => void

  public el: HTMLButtonElement
  private config: PetalConfig
  private isHovered = false
  private isSelected = false
  private interactive: boolean

  get isInteractive(): boolean { return this.interactive }

  get hue(): number {
    return this.config.hue
  }

  constructor(
    config: PetalConfig,
    onClick?: () => void,
    onMouseEnter?: () => void,
    onMouseLeave?: () => void,
  ) {
    this.onClick = onClick
    this.onMouseEnter = onMouseEnter
    this.onMouseLeave = onMouseLeave

    this.config = config
    this.interactive = !!onClick
    this.el = createElement(
      'button',
      undefined,
      this.interactive
        ? {
            type: 'button',
            'aria-label': `Select color hue ${config.hue}`,
            tabIndex: '-1',
          }
        : {
            type: 'button',
            'aria-hidden': 'true',
            tabIndex: '-1',
          },
    )
    this.el.className = 'bcp-petal'

    if (config.alpha !== 0) {
      this.el.classList.add('bcp-petal-visible')
    }

    this.el.addEventListener('click', () => {
      this.onClick?.()
    })
    this.el.addEventListener('mouseenter', () => {
      if (!this.interactive || this.el.disabled || !this.lastExpanded || this.isHovered) return
      this.isHovered = true
      interfaceSounds.play('accentHover')
      this.onMouseEnter?.()
      this.updateStyles(this.lastExpanded)
    })
    this.el.addEventListener('mouseleave', () => {
      this.isHovered = false
      this.onMouseLeave?.()
      this.updateStyles(this.lastExpanded)
    })

    this.applyBaseStyles()
    this.updateStyles(false)
  }

  private lastExpanded = false

  private applyBaseStyles(): void {
    const { petalSize, config: c } = {
      petalSize: this.config.petalSize,
      config: this.config,
    }
    setStyles(this.el, {
      position: 'absolute',
      width: `${petalSize}px`,
      height: `${petalSize}px`,
      borderRadius: '50%',
      border: 'none',
      padding: '0',
      background: 'none',
      left: '50%',
      top: '50%',
      marginLeft: `${-petalSize / 2}px`,
      marginTop: `${-petalSize / 2}px`,
    })

    if (c.clip === 'left') {
      this.el.style.clipPath = 'polygon(0% -50%, 50% -50%, 50% 150%, 0% 150%)'
    } else if (c.clip === 'right') {
      this.el.style.clipPath = 'polygon(50% -50%, 100% -50%, 100% 150%, 50% 150%)'
    }
  }

  setSelected(selected: boolean): void {
    this.isSelected = selected
    if (this.interactive) this.el.setAttribute('aria-pressed', String(selected))
    this.updateStyles(this.lastExpanded)
  }

  update(
    isExpanded: boolean,
    externalHover?: boolean,
    mousePos?: { x: number; y: number } | null,
    disabled = false,
  ): void {
    this.el.disabled = !this.interactive || disabled || !isExpanded
    if (this.el.disabled) this.isHovered = false
    if (externalHover !== undefined) {
      this.isHovered = externalHover
    }
    this.updateStyles(isExpanded, mousePos)
  }

  private updateStyles(isExpanded: boolean, mousePos?: { x: number; y: number } | null): void {
    const isExpanding = isExpanded && !this.lastExpanded
    const c = this.config
    const isHovered = this.isHovered
    const isInvisible = c.alpha === 0

    const angle = (c.index / c.totalPetals) * 360 - 90 + c.rotationOffset
    const radian = (angle * Math.PI) / 180
    let x = Math.cos(radian) * c.radius
    let y = Math.sin(radian) * c.radius

    if (isExpanded && mousePos && !isHovered && !isInvisible) {
      const dx = x - mousePos.x
      const dy = y - mousePos.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDistance = 60

      if (dist < minDistance) {
        const pushStrength = (1 - dist / minDistance) * 6
        const pushAngle = Math.atan2(dy, dx)
        x += Math.cos(pushAngle) * pushStrength
        y += Math.sin(pushAngle) * pushStrength
      }
    }

    const color =
      c.alpha < 1
        ? hslaToString(c.hue, c.saturation, c.lightness, c.alpha * 100)
        : hslToString(c.hue, c.saturation, c.lightness)

    const scale = c.animationDuration === 0 ? 1 : isHovered ? 1.12 : this.isSelected ? 1.05 : 1

    const transformTransition =
      isExpanded && !isExpanding && mousePos && !isHovered
        ? 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)'
        : `transform ${c.animationDuration}ms ${BLOOM_EASING} ${isExpanded && !isHovered ? c.animationDuration === 0 ? 0 : c.staggerDelay : 0}ms`

    setStyles(this.el, {
      backgroundColor: color,
      transform: isExpanded
        ? `translate(${x}px, ${y}px) scale(${scale})`
        : 'translate(0, 0) scale(0.85)',
      opacity: isExpanded ? '1' : '0',
      filter: isHovered && !isInvisible ? 'brightness(1.15) saturate(1.1)' : 'brightness(1)',
      transition: `${transformTransition},
                   opacity ${c.animationDuration}ms ${BLOOM_EASING} ${isExpanded && !isHovered ? c.animationDuration === 0 ? 0 : c.staggerDelay : 0}ms,
                   background-color 150ms ease,
                   box-shadow 150ms ease,
                   filter 150ms ease`,
      boxShadow:
        this.isSelected && this.interactive ? '0 0 0 2px var(--color-bg), 0 0 0 4px var(--ring)' : c.hasShadow && !isInvisible
          ? isHovered
            ? 'var(--shadow-xl)'
            : this.isSelected
              ? '0 0 0 2.5px var(--color-bg), var(--shadow-lg)'
              : 'var(--shadow-md)'
          : 'none',
      zIndex: String(c.zIndex),
      pointerEvents: this.el.disabled || !isExpanded ? 'none' : c.pointerEvents,
    })

    if (this.interactive) {
      if (!isExpanded || this.el.disabled) this.el.tabIndex = -1
    }
    this.lastExpanded = isExpanded
  }

  destroy(): void {
    this.el.remove()
  }
}
