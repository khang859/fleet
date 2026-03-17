/**
 * CommsBeamRenderer — Animated orbs that travel along beam lines
 * between crew pods and the central hub.
 */

type Beam = {
  fromId: string
  toId: string
  color: string
  progress: number // 0..1
  alive: boolean
}

const BEAM_DURATION_MS = 1000
const ORB_RADIUS = 3

export class CommsBeamRenderer {
  private beams: Beam[] = []
  /** Map of id -> {x, y} positions, updated externally */
  private positions = new Map<string, { x: number; y: number }>()

  /** Register a position for a node (pod or hub). Call before render. */
  setPosition(id: string, x: number, y: number): void {
    this.positions.set(id, { x, y })
  }

  /** Clear all registered positions (call at start of each frame). */
  clearPositions(): void {
    this.positions.clear()
  }

  hasActiveBeams(): boolean {
    return this.beams.length > 0
  }

  addBeam(from: string, to: string, color: string): void {
    this.beams.push({
      fromId: from,
      toId: to,
      color,
      progress: 0,
      alive: true
    })
  }

  update(deltaMs: number): void {
    const step = deltaMs / BEAM_DURATION_MS
    for (const beam of this.beams) {
      if (!beam.alive) continue
      beam.progress += step
      if (beam.progress >= 1) {
        beam.alive = false
      }
    }
    // Remove dead beams
    this.beams = this.beams.filter((b) => b.alive)
  }

  render(ctx: CanvasRenderingContext2D, _centerX: number, _centerY: number): void {
    if (this.beams.length === 0) return

    ctx.save()

    for (const beam of this.beams) {
      const from = this.positions.get(beam.fromId)
      const to = this.positions.get(beam.toId)
      if (!from || !to) continue

      const t = beam.progress
      const ox = from.x + (to.x - from.x) * t
      const oy = from.y + (to.y - from.y) * t

      // Faint trail line
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(ox, oy)
      ctx.strokeStyle = beam.color
      ctx.globalAlpha = 0.15
      ctx.lineWidth = 1
      ctx.stroke()

      // Orb glow
      ctx.beginPath()
      ctx.arc(ox, oy, ORB_RADIUS + 2, 0, Math.PI * 2)
      ctx.fillStyle = beam.color
      ctx.globalAlpha = 0.3
      ctx.fill()

      // Orb
      ctx.beginPath()
      ctx.arc(ox, oy, ORB_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = beam.color
      ctx.globalAlpha = 0.9
      ctx.fill()
    }

    ctx.restore()
  }
}
