import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader'

export type SectorState = {
  id: string
  name: string
  active: boolean
}

export class SectorOutpostRenderer {
  render(
    ctx: CanvasRenderingContext2D,
    sectors: SectorState[],
    positions: Map<string, { x: number; y: number }>,
    elapsed: number
  ): void {
    if (sectors.length === 0) return
    if (!isScSpriteReady()) return

    ctx.save()
    ctx.imageSmoothingEnabled = false

    for (const sector of sectors) {
      const pos = positions.get(sector.id)
      if (!pos) continue
      const { x, y } = pos

      // Active glow
      if (sector.active) {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 24)
        grad.addColorStop(0, 'rgba(20,184,166,0.25)')
        grad.addColorStop(1, 'rgba(20,184,166,0)')
        ctx.beginPath()
        ctx.arc(x, y, 24, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.globalAlpha = 1
        ctx.fill()
      }

      // Beacon sprite (12×12 centered)
      ctx.globalAlpha = sector.active ? 1 : 0.4
      drawScSprite(ctx, 'beacon', elapsed, x - 6, y - 6, 12, 12)

      // Label — 14px below bottom of beacon
      ctx.globalAlpha = sector.active ? 0.9 : 0.4
      ctx.fillStyle = '#ffffff'
      ctx.font = '9px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(sector.name, x, y + 20) // 6 (half beacon) + 14 (gap)
    }

    ctx.restore()
  }
}
