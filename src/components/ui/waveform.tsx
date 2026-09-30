import { useEffect, useEffectEvent, useRef, type HTMLAttributes } from "react"

import { cn } from "@/lib/utils"
import { waveformLayout } from "@/lib/waveform-layout"

export type WaveformProps = HTMLAttributes<HTMLDivElement> & {
  data?: number[]
  barWidth?: number
  barHeight?: number
  barGap?: number
  barRadius?: number
  barColor?: string
  fadeEdges?: boolean
  fadeWidth?: number
  height?: string | number
  active?: boolean
  onBarClick?: (index: number, value: number) => void
}

export const Waveform = ({
  data = [],
  barWidth = 4,
  barHeight: baseBarHeight = 4,
  barGap = 2,
  barRadius = 2,
  barColor,
  fadeEdges = true,
  fadeWidth = 24,
  height = 128,
  onBarClick,
  className,
  ...props
}: WaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const heightStyle = typeof height === "number" ? `${height}px` : height

  const renderWaveform = useEffectEvent(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return

    const rect = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, rect.width, rect.height)

    const computedBarColor =
      barColor || getComputedStyle(canvas).getPropertyValue("--foreground") || "#000"
    const { count, step, startX } = waveformLayout(rect.width, barWidth, barGap)
    const centerY = rect.height / 2

    for (let i = 0; i < count; i++) {
      const dataIndex = Math.floor((i / count) * data.length)
      const value = data[dataIndex] || 0
      const barHeight = Math.max(baseBarHeight, value * rect.height * 0.8)
      const x = startX + i * step
      const y = centerY - barHeight / 2

      ctx.fillStyle = computedBarColor
      ctx.globalAlpha = 0.3 + value * 0.7
      if (barRadius > 0) {
        ctx.beginPath()
        ctx.roundRect(x, y, barWidth, barHeight, barRadius)
        ctx.fill()
      } else {
        ctx.fillRect(x, y, barWidth, barHeight)
      }
    }

    if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
      const gradient = ctx.createLinearGradient(0, 0, rect.width, 0)
      const fadePercent = Math.min(0.2, fadeWidth / rect.width)
      gradient.addColorStop(0, "rgba(255,255,255,1)")
      gradient.addColorStop(fadePercent, "rgba(255,255,255,0)")
      gradient.addColorStop(1 - fadePercent, "rgba(255,255,255,0)")
      gradient.addColorStop(1, "rgba(255,255,255,1)")
      ctx.globalCompositeOperation = "destination-out"
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, rect.width, rect.height)
      ctx.globalCompositeOperation = "source-over"
    }
    ctx.globalAlpha = 1
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderWaveform()
    }

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    return () => observer.disconnect()
  }, [])

  // New audio samples redraw the existing canvas without reallocating it.
  useEffect(() => {
    renderWaveform()
  }, [data, barWidth, baseBarHeight, barGap, barRadius, barColor, fadeEdges, fadeWidth])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onBarClick) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const { count, step, startX } = waveformLayout(rect.width, barWidth, barGap)
    const barIndex = Math.floor((e.clientX - rect.left - startX) / step)
    if (barIndex < 0 || barIndex >= count) return
    const dataIndex = Math.floor((barIndex / count) * data.length)
    if (dataIndex < data.length) onBarClick(dataIndex, data[dataIndex])
  }

  return (
    <div
      className={cn("relative", className)}
      ref={containerRef}
      style={{ height: heightStyle }}
      {...props}
    >
      <canvas className="block h-full w-full" onClick={handleClick} ref={canvasRef} />
    </div>
  )
}
