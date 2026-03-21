import type { SectorInfo, CrewStatus } from '../../store/star-command-store'
import type { SectorState } from '../visualizer/sector-outposts'
import type { PodState } from '../visualizer/shuttles'

const VALID_POD_STATUSES = new Set<string>([
  'active', 'hailing', 'error', 'complete', 'lost', 'idle',
])

export function isValidPodStatus(s: string): s is PodState['status'] {
  return VALID_POD_STATUSES.has(s)
}

function toValidPodStatus(s: string): PodState['status'] {
  return isValidPodStatus(s) ? s : 'idle'
}

export function mapSectors(sectors: SectorInfo[], crew: CrewStatus[]): SectorState[] {
  return sectors.map((s) => ({
    id: s.id,
    name: s.name,
    active: crew.some((c) => c.sector_id === s.id && c.status === 'active'),
  }))
}

export function mapCrew(crew: CrewStatus[]): PodState[] {
  return crew.map((c) => ({
    crewId: c.id,
    sectorId: c.sector_id,
    status: toValidPodStatus(c.status),
  }))
}

export function computeSectorPositions(
  sectors: SectorState[],
  cx: number,
  cy: number,
  radius: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (sectors.length === 0) return positions
  const count = sectors.length
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count
    positions.set(sectors[i].id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    })
  }
  return positions
}
