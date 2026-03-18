import { useRef, useEffect } from 'react'
import { useStarCommandStore } from '../../store/star-command-store'
import { SectorOutpostRenderer } from '../visualizer/sector-outposts'
import { ShuttleRenderer } from '../visualizer/shuttles'
import { SignalPulseRenderer } from '../visualizer/signal-pulses'
import { mapSectors, mapCrew, computeSectorPositions } from './scene-utils'
import type { SectorState } from '../visualizer/sector-outposts'
import type { PodState } from '../visualizer/shuttles'
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader'

export function StarCommandScene({ className, isActive = true }: { className?: string; isActive?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const lastFrameRef = useRef<number>(0)
  const pendingResizeRef = useRef(false)
  const stoppedRef = useRef(false)
  const frameRef = useRef<(now: number) => void>(() => {})

  const sectorStatesRef = useRef<SectorState[]>([])
  const podStatesRef = useRef<PodState[]>([])

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

    const ro = new ResizeObserver(() => { pendingResizeRef.current = true })
    ro.observe(container)

    // --- Renderers ---
    const sectorOutposts = new SectorOutpostRenderer()
    const shuttleRenderer = new ShuttleRenderer()
    const signalPulses = new SignalPulseRenderer()
    let lastPulseSpawn = 0

    function frame(now: number) {
      if (stoppedRef.current) return
      if (pendingResizeRef.current) applyResize()

      // Adaptive FPS throttle
      const hasActiveCrew = podStatesRef.current.some(
        p => p.status === 'active' || p.status === 'hailing' || p.status === 'error'
      )
      const hasActiveAnimation = hasActiveCrew || shuttleRenderer.hasActiveShuttles() || signalPulses.hasActivePulses()
      const frameBudget = hasActiveAnimation ? 33 : 100

      if (now - lastFrameRef.current < frameBudget) {
        rafRef.current = requestAnimationFrame(frame)
        return
      }

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16
      lastFrameRef.current = now
      elapsed += deltaMs

      const w = canvas!.width
      const h = canvas!.height

      // Background
      ctx!.fillStyle = '#0a0a1a'
      ctx!.fillRect(0, 0, w, h)

      // Starfield
      if (now - lastStarRedraw >= 200) {
        redrawStars()
        lastStarRedraw = now
      }
      ctx!.drawImage(starOffscreen, 0, 0)

      const cx = w / 2
      const cy = h / 2
      const scale = Math.min(w, h) / 600
      const outpostRadius = Math.min(w, h) * 0.42

      const currentSectors = sectorStatesRef.current
      const currentPods = podStatesRef.current
      const sectorPositions = computeSectorPositions(currentSectors, cx, cy, outpostRadius)

      // Update renderers
      shuttleRenderer.update(currentPods, sectorPositions, cx, cy, deltaMs)
      signalPulses.update(deltaMs)

      // Spawn signal pulses every 3s for hailing crew
      if (elapsed - lastPulseSpawn >= 3000) {
        for (const pod of currentPods) {
          if (pod.status === 'hailing') {
            const pos = shuttleRenderer.getShuttlePosition(pod.crewId)
            if (pos) signalPulses.addPulse(pos.x, pos.y, cx, cy)
          }
        }
        lastPulseSpawn = elapsed
      }

      // Render layers (back to front)
      sectorOutposts.render(ctx!, currentSectors, sectorPositions, elapsed)
      signalPulses.render(ctx!, elapsed)
      shuttleRenderer.render(ctx!, elapsed)

      // Hub sprite on top
      if (isScSpriteReady()) {
        const hubSize = 128 * scale
        ctx!.imageSmoothingEnabled = false
        drawScSprite(ctx!, 'station-hub', elapsed, cx - hubSize / 2, cy - hubSize / 2, hubSize, hubSize)
      }

      rafRef.current = requestAnimationFrame(frame)
    }
    frameRef.current = frame

    const handleVisibility = () => {
      if (document.hidden) {
        stoppedRef.current = true
        cancelAnimationFrame(rafRef.current)
      } else {
        stoppedRef.current = false
        lastFrameRef.current = 0
        rafRef.current = requestAnimationFrame(frame)
      }
    }
    const handleBlur = () => { stoppedRef.current = true; cancelAnimationFrame(rafRef.current) }
    const handleFocus = () => {
      if (!stoppedRef.current) return
      stoppedRef.current = false
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(frame)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleFocus)
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      stoppedRef.current = true
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  useEffect(() => {
    if (!isActive) {
      stoppedRef.current = true
      cancelAnimationFrame(rafRef.current)
    } else if (stoppedRef.current) {
      stoppedRef.current = false
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(frameRef.current)
    }
  }, [isActive])

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  )
}
