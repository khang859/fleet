import { useRef, useEffect } from 'react'
import { useStarCommandStore } from '../../store/star-command-store'
import { StationRing } from '../visualizer/station-ring'
import { CrewPodRenderer } from '../visualizer/crew-pods'
import { mapSectors, mapCrew } from './scene-utils'
import type { SectorState } from '../visualizer/station-ring'
import type { PodState } from '../visualizer/crew-pods'
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader'

export function StarCommandScene({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const lastFrameRef = useRef<number>(0)
  const pendingResizeRef = useRef(false)

  const sectorStatesRef = useRef<SectorState[]>([])
  const podStatesRef = useRef<PodState[]>([])

  // Sync store data into refs without causing re-renders
  const { sectors, crewList } = useStarCommandStore()
  useEffect(() => {
    sectorStatesRef.current = mapSectors(sectors, crewList)
    podStatesRef.current = mapCrew(crewList)
  }, [sectors, crewList])

  useEffect(() => {
    loadScSpriteSheet()

    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    // --- Starfield ---
    type Star = { x: number; y: number; radius: number; phase: number; speed: number }

    const STAR_COUNT = 150
    let stars: Star[] = []

    const scatterStars = (w: number, h: number) => {
      stars = Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        radius: Math.random() * 1.2 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.0008 + 0.0002,
      }))
    }

    let starOffscreen = new OffscreenCanvas(canvas.width, canvas.height)
    let starCtx = starOffscreen.getContext('2d')!
    let lastStarRedraw = 0
    let elapsed = 0

    const redrawStars = () => {
      starCtx.clearRect(0, 0, starOffscreen.width, starOffscreen.height)
      for (const star of stars) {
        const brightness = 0.4 + 0.6 * Math.abs(Math.sin(elapsed * star.speed + star.phase))
        starCtx.beginPath()
        starCtx.arc(star.x, star.y, star.radius, 0, Math.PI * 2)
        starCtx.fillStyle = `rgba(255,255,255,${brightness.toFixed(2)})`
        starCtx.fill()
      }
    }

    // Sync canvas size to container
    const applyResize = () => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
      pendingResizeRef.current = false
      starOffscreen = new OffscreenCanvas(canvas.width, canvas.height)
      starCtx = starOffscreen.getContext('2d')!
      scatterStars(canvas.width, canvas.height)
      redrawStars()
    }
    applyResize()

    const ro = new ResizeObserver(() => {
      // Debounce: apply resize on next RAF tick
      pendingResizeRef.current = true
    })
    ro.observe(container)

    const stationRing = new StationRing()
    const crewPods = new CrewPodRenderer()

    let stopped = false

    function frame(now: number) {
      if (stopped) return

      // Apply pending resize
      if (pendingResizeRef.current) applyResize()

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16
      lastFrameRef.current = now
      elapsed += deltaMs

      const w = canvas!.width
      const h = canvas!.height

      // Background
      ctx!.fillStyle = '#0a0a1a'
      ctx!.fillRect(0, 0, w, h)

      // Starfield — redraw offscreen at 5fps, blit every frame
      if (now - lastStarRedraw >= 200) {
        redrawStars()
        lastStarRedraw = now
      }
      ctx!.drawImage(starOffscreen, 0, 0)

      const cx = w / 2
      const cy = h / 2
      const scale = Math.min(w, h) / 600 // 600 is reference size

      const sectors = sectorStatesRef.current
      const pods = podStatesRef.current

      stationRing.update(sectors, deltaMs)
      crewPods.update(pods, deltaMs)

      // Scale context for ring and pods
      ctx!.save()
      ctx!.translate(cx, cy)
      ctx!.scale(scale, scale)
      ctx!.translate(-cx, -cy)
      stationRing.render(ctx!, cx, cy)
      crewPods.render(ctx!, cx, cy, stationRing)
      ctx!.restore()

      // Station hub sprite (centered, drawn on top of ring)
      if (isScSpriteReady()) {
        const hubSize = 128 * scale
        ctx!.imageSmoothingEnabled = false
        drawScSprite(ctx!, 'station-hub', elapsed, cx - hubSize / 2, cy - hubSize / 2, hubSize, hubSize)
      }

      rafRef.current = requestAnimationFrame(frame)
    }

    const handleVisibility = () => {
      if (document.hidden) {
        stopped = true
        cancelAnimationFrame(rafRef.current)
      } else {
        stopped = false
        lastFrameRef.current = 0 // reset to avoid deltaMs spike
        rafRef.current = requestAnimationFrame(frame)
      }
    }
    const handleBlur = () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
    }
    const handleFocus = () => {
      if (!stopped) return
      stopped = false
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(frame)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)

    rafRef.current = requestAnimationFrame(frame)

    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  )
}
