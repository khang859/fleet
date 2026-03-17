import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader'

export type PodState = {
  crewId: string
  sectorId: string
  status: 'active' | 'hailing' | 'error' | 'complete' | 'lost' | 'idle'
}

type ShuttleState = 'orbiting' | 'flying-to-hub' | 'returning' | 'docking' | 'drifting'

type ShuttleEntry = {
  crewId: string
  sectorId: string
  state: ShuttleState
  x: number
  y: number
  vx: number             // velocity used for sprite rotation
  vy: number
  orbitPhase: number     // accumulates each frame
  orbitSpeed: number     // rad/s (0.6–1.0), deterministic from crewId
  alpha: number          // 1.0 normally; fades in drifting
  returnTargetX: number  // snapshot of outpost at time of returning-state entry
  returnTargetY: number
  dockElapsed: number    // ms elapsed in docking animation
  driftElapsed: number   // ms elapsed while drifting
}

const ORBIT_RADIUS = 35
const TRAVEL_SPEED = 80       // px/s
const ARRIVAL_THRESHOLD = 20  // px
const DOCK_DURATION = 450     // ms (3 frames × 150ms)
const DRIFT_DURATION = 3000   // ms

function crewHash(id: string): number {
  let sum = 0
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i)
  return sum
}

export class ShuttleRenderer {
  private entries = new Map<string, ShuttleEntry>()
  private lastStatus = new Map<string, PodState['status']>()

  update(
    pods: PodState[],
    positions: Map<string, { x: number; y: number }>,
    hubX: number,
    hubY: number,
    deltaMs: number
  ): void {
    const dt = deltaMs / 1000
    const activeCrew = new Set(pods.map(p => p.crewId))

    // Remove entries for crew no longer in the list
    for (const [id] of this.entries) {
      if (!activeCrew.has(id)) {
        this.entries.delete(id)
        this.lastStatus.delete(id)
      }
    }

    for (const pod of pods) {
      const prevStatus = this.lastStatus.get(pod.crewId)
      const statusChanged = prevStatus !== undefined && prevStatus !== pod.status
      const sectorPos = positions.get(pod.sectorId)
      let entry = this.entries.get(pod.crewId)

      // Idle: no shuttle
      if (pod.status === 'idle') {
        this.entries.delete(pod.crewId)
        this.lastStatus.set(pod.crewId, pod.status)
        continue
      }

      // No sector position: skip
      if (!sectorPos) {
        this.lastStatus.set(pod.crewId, pod.status)
        continue
      }

      const { x: sx, y: sy } = sectorPos

      // Create entry if none exists
      if (!entry) {
        // First observation as complete/lost: skip animation
        if (pod.status === 'complete' || pod.status === 'lost') {
          this.lastStatus.set(pod.crewId, pod.status)
          continue
        }
        const hash = crewHash(pod.crewId)
        const initPhase = hash % (2 * Math.PI)  // 0..2π, deterministic
        const speed = 0.6 + 0.4 * (hash % 100) / 100
        entry = {
          crewId: pod.crewId,
          sectorId: pod.sectorId,
          state: pod.status === 'hailing' ? 'flying-to-hub' : 'orbiting',
          x: sx + Math.cos(initPhase) * ORBIT_RADIUS,
          y: sy + Math.sin(initPhase) * ORBIT_RADIUS,
          vx: 0,
          vy: 0,
          orbitPhase: initPhase,
          orbitSpeed: speed,
          alpha: 1,
          returnTargetX: sx,
          returnTargetY: sy,
          dockElapsed: 0,
          driftElapsed: 0,
        }
        this.entries.set(pod.crewId, entry)
      }

      // Re-trigger flying-to-hub whenever hailing and back to orbiting
      if (pod.status === 'hailing' && entry.state === 'orbiting') {
        entry.state = 'flying-to-hub'
      }

      // Handle explicit status transitions
      if (statusChanged) {
        if (pod.status === 'complete' && entry.state !== 'docking') {
          entry.state = 'docking'
          entry.dockElapsed = 0
          entry.x = sx
          entry.y = sy
        } else if (pod.status === 'lost' && entry.state !== 'drifting') {
          entry.state = 'drifting'
          entry.driftElapsed = 0
          entry.alpha = 1
          const dx = entry.x - hubX
          const dy = entry.y - hubY
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          entry.vx = (dx / dist) * 15
          entry.vy = (dy / dist) * 15
        }
      }

      this.lastStatus.set(pod.crewId, pod.status)

      // Physics update
      switch (entry.state) {
        case 'orbiting': {
          let speed = entry.orbitSpeed
          if (pod.status === 'error') speed *= (Math.random() * 0.5 + 0.75)
          entry.orbitPhase += speed * dt
          if (entry.orbitPhase > Math.PI * 2) entry.orbitPhase -= Math.PI * 2
          const newX = sx + Math.cos(entry.orbitPhase) * ORBIT_RADIUS
          const newY = sy + Math.sin(entry.orbitPhase) * ORBIT_RADIUS
          entry.vx = (newX - entry.x) / Math.max(dt, 0.001)
          entry.vy = (newY - entry.y) / Math.max(dt, 0.001)
          entry.x = newX
          entry.y = newY
          break
        }
        case 'flying-to-hub': {
          const dx = hubX - entry.x
          const dy = hubY - entry.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist <= ARRIVAL_THRESHOLD) {
            // Snapshot outpost for return trip
            const sp = positions.get(entry.sectorId)
            entry.returnTargetX = sp ? sp.x : sx
            entry.returnTargetY = sp ? sp.y : sy
            entry.state = 'returning'
          } else {
            const step = Math.min(TRAVEL_SPEED * dt, dist)
            entry.vx = (dx / dist) * TRAVEL_SPEED
            entry.vy = (dy / dist) * TRAVEL_SPEED
            entry.x += (dx / dist) * step
            entry.y += (dy / dist) * step
          }
          break
        }
        case 'returning': {
          const dx = entry.returnTargetX - entry.x
          const dy = entry.returnTargetY - entry.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist <= ARRIVAL_THRESHOLD) {
            entry.state = 'orbiting'
          } else {
            const step = Math.min(TRAVEL_SPEED * dt, dist)
            entry.vx = (dx / dist) * TRAVEL_SPEED
            entry.vy = (dy / dist) * TRAVEL_SPEED
            entry.x += (dx / dist) * step
            entry.y += (dy / dist) * step
          }
          break
        }
        case 'docking': {
          entry.dockElapsed += deltaMs
          if (entry.dockElapsed >= DOCK_DURATION) {
            this.entries.delete(pod.crewId)
          }
          break
        }
        case 'drifting': {
          entry.driftElapsed += deltaMs
          entry.x += entry.vx * dt
          entry.y += entry.vy * dt
          entry.alpha = Math.max(0, 1 - entry.driftElapsed / DRIFT_DURATION)
          if (entry.driftElapsed >= DRIFT_DURATION) {
            this.entries.delete(pod.crewId)
          }
          break
        }
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, elapsed: number): void {
    if (!isScSpriteReady()) return
    ctx.save()
    ctx.imageSmoothingEnabled = false

    for (const entry of this.entries.values()) {
      if (entry.state === 'docking') {
        // dock-sparkle (8×8 centered at outpost)
        ctx.globalAlpha = 1
        drawScSprite(ctx, 'dock-sparkle', entry.dockElapsed, entry.x - 4, entry.y - 4, 8, 8)
        continue
      }

      ctx.globalAlpha = entry.state === 'drifting' ? entry.alpha : 1

      // Rotate sprite to face direction of travel
      const angle = Math.atan2(entry.vy, entry.vx)
      const spriteKey = entry.state === 'drifting' ? 'shuttle-idle' : 'shuttle-thrust'

      ctx.save()
      ctx.translate(entry.x, entry.y)
      ctx.rotate(angle)
      drawScSprite(ctx, spriteKey, elapsed, -12, -12, 24, 24)
      ctx.restore()
    }

    ctx.restore()
  }

  getShuttlePosition(crewId: string): { x: number; y: number } | null {
    const entry = this.entries.get(crewId)
    return entry ? { x: entry.x, y: entry.y } : null
  }

  hasActiveShuttles(): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.state === 'flying-to-hub' ||
        entry.state === 'returning' ||
        entry.state === 'docking' ||
        entry.state === 'drifting'
      ) return true
    }
    return false
  }
}
