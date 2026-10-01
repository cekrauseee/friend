import { useEffect, useEffectEvent, useRef, type HTMLAttributes } from 'react'
import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { waveformLayout } from '@/lib/waveform-layout'

// Adapted from ElevenLabs UI LiveWaveform (MIT). Capture stays with the session;
// this controlled static renderer never opens a microphone or owns audio tracks.
export type LiveWaveformProps = HTMLAttributes<HTMLDivElement> & {
  data: number[]
  active?: boolean
  processing?: boolean
  sensitivity?: number
  height?: number
  barWidth?: number
  barGap?: number
  barHeight?: number
  barRadius?: number
}

export function LiveWaveform({ data, active = false, processing = false, sensitivity = 1, height = 24,
  barWidth = 3, barGap = 3, barHeight = 3, barRadius = 2, className, ...props }: LiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const lastActive = useRef<number[]>([])
  const reducedMotion = useReducedMotion()

  const draw = useEffectEvent((elapsed = 0) => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const rect = canvas.getBoundingClientRect()
    const { count, step, startX } = waveformLayout(rect.width, barWidth, barGap)
    const samples = []
    const progress = reducedMotion ? 1 : Math.min(1, elapsed / 300)
    // ElevenLabs' processing wave: three gentle oscillations, weighted toward
    // the center, blending out of the last voice sample without remounting.
    const time = reducedMotion ? 0 : elapsed / 550
    for (let index = 0; index < count; index++) {
      const position = (index - count / 2) / Math.max(1, count / 2)
      const wave = (0.2 + Math.sin(time * 1.5 + position * 3) * 0.25
        + Math.sin(time * 0.8 - position * 2) * 0.2
        + Math.cos(time * 2 + position) * 0.15) * (1 - Math.abs(position) * 0.4)
      const source = processing ? lastActive.current : data
      const measured = source[Math.floor(index / Math.max(1, count) * source.length)] ?? 0
      const value = Math.max(0, Math.min(1, measured * sensitivity))
      samples.push(processing ? Math.max(0.05, Math.min(1, value * (1 - progress) + wave * progress)) : active ? value : 0)
    }
    if (active && !processing) lastActive.current = data
    context.clearRect(0, 0, rect.width, rect.height)
    context.fillStyle = getComputedStyle(canvas).color
    for (let index = 0; index < count; index++) {
      const value = samples[index]
      const size = Math.max(barHeight, value * rect.height * 0.8)
      context.globalAlpha = 0.4 + value * 0.6
      context.beginPath()
      context.roundRect(startX + index * step, (rect.height - size) / 2, barWidth, size, barRadius)
      context.fill()
    }
    context.globalAlpha = 1
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const resize = () => {
      const rect = container.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * ratio)
      canvas.height = Math.round(rect.height * ratio)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      canvas.getContext('2d')?.setTransform(ratio, 0, 0, ratio, 0, 0)
      draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!processing || reducedMotion) { draw(); return }
    let frame = 0
    let started: number | undefined
    const animate = (time: number) => {
      started ??= time
      draw(time - started)
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [processing, reducedMotion])

  useEffect(() => {
    if (!processing) draw()
  }, [data, active, processing, sensitivity, height, barWidth, barGap, barHeight, barRadius])

  return (
    <div ref={containerRef} className={cn('relative h-full w-full', className)} style={{ height }}
      data-slot="live-waveform" data-processing={processing} {...props}>
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden="true" />
    </div>
  )
}
