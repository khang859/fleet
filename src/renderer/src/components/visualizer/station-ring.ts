/**
 * StationRing — A slowly rotating circular structure divided into sector arcs.
 * Active sectors (with active crew) are lit teal; inactive are dim.
 */

export type SectorState = {
  id: string
  name: string
  active: boolean
}

const RING_RADIUS = 120
const ARC_WIDTH = 12
const GAP_DEG = 2
const COLOR_ACTIVE = '#14b8a6'
const COLOR_INACTIVE = '#374151'
const ROTATION_SPEED = 0.015 // radians per second

export class StationRing {
  private rotation = 0
  private sectors: SectorState[] = []

  update(sectors: SectorState[], deltaMs: number): void {
    this.sectors = sectors
    this.rotation += ROTATION_SPEED * (deltaMs / 1000)
    if (this.rotation > Math.PI * 2) this.rotation -= Math.PI * 2
  }

  render(ctx: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const count = this.sectors.length
    if (count === 0) return

    const gapRad = (GAP_DEG * Math.PI) / 180
    const totalGap = gapRad * count
    const arcPerSector = (Math.PI * 2 - totalGap) / count

    ctx.save()
    ctx.lineWidth = ARC_WIDTH
    ctx.lineCap = 'butt'
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    let angle = this.rotation

    for (const sector of this.sectors) {
      const startAngle = angle
      const endAngle = angle + arcPerSector

      // Draw arc
      ctx.beginPath()
      ctx.arc(centerX, centerY, RING_RADIUS, startAngle, endAngle)
      ctx.strokeStyle = sector.active ? COLOR_ACTIVE : COLOR_INACTIVE
      ctx.globalAlpha = sector.active ? 0.8 : 0.3
      ctx.stroke()

      // Label at arc midpoint
      const midAngle = (startAngle + endAngle) / 2
      const labelRadius = RING_RADIUS + ARC_WIDTH + 6
      const lx = centerX + Math.cos(midAngle) * labelRadius
      const ly = centerY + Math.sin(midAngle) * labelRadius

      ctx.globalAlpha = sector.active ? 0.9 : 0.4
      ctx.fillStyle = '#ffffff'
      ctx.fillText(sector.name, lx, ly)

      angle = endAngle + gapRad
    }

    ctx.restore()
  }

  getRadius(): number {
    return RING_RADIUS
  }

  /** Get the angular range for a sector by index (accounts for rotation). */
  getSectorArc(index: number): { start: number; end: number } {
    const count = this.sectors.length
    if (count === 0) return { start: 0, end: 0 }

    const gapRad = (GAP_DEG * Math.PI) / 180
    const totalGap = gapRad * count
    const arcPerSector = (Math.PI * 2 - totalGap) / count

    const start = this.rotation + index * (arcPerSector + gapRad)
    return { start, end: start + arcPerSector }
  }

  getSectorIndex(sectorId: string): number {
    return this.sectors.findIndex((s) => s.id === sectorId)
  }
}
