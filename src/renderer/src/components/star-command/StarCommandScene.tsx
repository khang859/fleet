import { useRef, useEffect } from 'react'
import { useStarCommandStore } from '../../store/star-command-store'
import { StationRing } from '../visualizer/station-ring'
import { CrewPodRenderer } from '../visualizer/crew-pods'
import { mapSectors, mapCrew } from './scene-utils'
import type { SectorState } from '../visualizer/station-ring'
import type { PodState } from '../visualizer/crew-pods'
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader'
import { CommsBeamRenderer } from '../visualizer/comms-beams'

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
    const commsBeams = new CommsBeamRenderer()
    let lastBeamSpawn = 0

    let stopped = false

    function frame(now: number) {
      if (stopped) return

      // Apply pending resize
      if (pendingResizeRef.current) applyResize()

      // Adaptive FPS throttle
      const hasActiveCrew = podStatesRef.current.some(
        (p) => p.status === 'active' || p.status === 'hailing'
      )
      const hasBeams = commsBeams.hasActiveBeams()
      const isActive = hasActiveCrew || hasBeams
      const frameBudget = isActive ? 33 : 100 // 30fps vs 10fps

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

      // Register positions for comms beams
      commsBeams.clearPositions()
      commsBeams.setPosition('hub', cx, cy)

      // Compute pod positions (same math as CrewPodRenderer)
      const RING_RADIUS = 120 * scale
      const POD_OFFSET = 4 * scale
      const podRadius = RING_RADIUS - POD_OFFSET
      const sectorCount = sectors.length
      if (sectorCount > 0) {
        const gapRad = (2 * Math.PI) / 180
        const totalGap = gapRad * sectorCount
        const arcPerSector = (Math.PI * 2 - totalGap) / sectorCount
        const podsBySector = new Map<string, PodState[]>()
        for (const pod of pods) {
          const list = podsBySector.get(pod.sectorId) ?? []
          list.push(pod)
          podsBySector.set(pod.sectorId, list)
        }
        let angle = (stationRing as any).rotation as number // read private rotation field
        for (const sector of sectors) {
          const sectorPods = podsBySector.get(sector.id) ?? []
          const count = sectorPods.length
          const endAngle = angle + arcPerSector
          for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0.5 : i / (count - 1)
            const podAngle = angle + arcPerSector * (0.15 + t * 0.7)
            const px = cx + Math.cos(podAngle) * podRadius
            const py = cy + Math.sin(podAngle) * podRadius
            commsBeams.setPosition(sectorPods[i].crewId, px, py)
          }
          angle = endAngle + gapRad
        }
      }

      // Spawn beams for hailing crew every 3 seconds (before update so beams advance their first frame)
      if (elapsed - lastBeamSpawn >= 3000) {
        for (const pod of pods) {
          if (pod.status === 'hailing') {
            commsBeams.addBeam(pod.crewId, 'hub', '#14b8a6')
          }
        }
        lastBeamSpawn = elapsed
      }

      commsBeams.update(deltaMs)

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

      commsBeams.render(ctx!, cx, cy)

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
