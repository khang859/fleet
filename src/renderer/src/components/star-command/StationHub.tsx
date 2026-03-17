import { useRef, useEffect } from 'react'
import { drawScSprite, isScSpriteReady } from './sc-sprite-loader'

const HUB_SIZE = 128

export function StationHub() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let elapsed = 0
    let lastTime = 0
    let rafId = 0

    function frame(now: number) {
      const delta = lastTime ? now - lastTime : 0
      lastTime = now
      elapsed += delta

      ctx!.clearRect(0, 0, HUB_SIZE, HUB_SIZE)
      if (isScSpriteReady()) {
        ctx!.imageSmoothingEnabled = false
        drawScSprite(ctx!, 'station-hub', elapsed, 0, 0, HUB_SIZE, HUB_SIZE)
      }

      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={HUB_SIZE}
      height={HUB_SIZE}
      style={{ imageRendering: 'pixelated', width: HUB_SIZE, height: HUB_SIZE }}
    />
  )
}
