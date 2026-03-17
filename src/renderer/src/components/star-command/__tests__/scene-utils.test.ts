import { describe, it, expect } from 'vitest'
import { mapSectors, mapCrew, computeSectorPositions } from '../scene-utils'
import type { SectorInfo, CrewStatus } from '../../../store/star-command-store'

const makeSector = (id: string, name = id): SectorInfo => ({
  id, name, root_path: '/tmp', stack: null,
})
const makeCrew = (id: string, sector_id: string, status: string): CrewStatus => ({
  id, sector_id, status, mission_summary: null, tab_id: null, avatar_variant: null, created_at: '',
})

describe('mapSectors', () => {
  it('marks sector active when any crew in it is active', () => {
    const sectors = [makeSector('api'), makeSector('web')]
    const crew = [makeCrew('c1', 'api', 'active')]
    const result = mapSectors(sectors, crew)
    expect(result.find(s => s.id === 'api')?.active).toBe(true)
    expect(result.find(s => s.id === 'web')?.active).toBe(false)
  })

  it('returns empty array for empty sectors', () => {
    expect(mapSectors([], [])).toEqual([])
  })

  it('marks sector inactive when crew status is not active', () => {
    const sectors = [makeSector('api')]
    const crew = [makeCrew('c1', 'api', 'hailing')]
    const result = mapSectors(sectors, crew)
    expect(result[0].active).toBe(false)
  })
})

describe('mapCrew', () => {
  it('maps crew to pod states with correct fields', () => {
    const crew = [makeCrew('c1', 'api', 'active')]
    const result = mapCrew(crew)
    expect(result).toEqual([{ crewId: 'c1', sectorId: 'api', status: 'active' }])
  })

  it('falls back to idle for unknown status', () => {
    const crew = [makeCrew('c1', 'api', 'unknown-status')]
    const result = mapCrew(crew)
    expect(result[0].status).toBe('idle')
  })

  it('returns empty array for empty crew', () => {
    expect(mapCrew([])).toEqual([])
  })
})

describe('computeSectorPositions', () => {
  it('returns empty map for empty sectors', () => {
    const result = computeSectorPositions([], 300, 200, 100)
    expect(result.size).toBe(0)
  })

  it('places a single sector at top (angle -π/2)', () => {
    const sectors = [{ id: 'api', name: 'api', active: false }]
    const result = computeSectorPositions(sectors, 300, 200, 100)
    const pos = result.get('api')!
    expect(pos.x).toBeCloseTo(300)       // cos(-π/2) = 0, so x = cx
    expect(pos.y).toBeCloseTo(100)       // sin(-π/2) = -1, so y = cy - radius
  })

  it('places two sectors 180° apart', () => {
    const sectors = [
      { id: 'a', name: 'a', active: false },
      { id: 'b', name: 'b', active: false },
    ]
    const result = computeSectorPositions(sectors, 300, 200, 100)
    const a = result.get('a')!
    const b = result.get('b')!
    // They should be exactly opposite: a.x + b.x ≈ 2*cx, a.y + b.y ≈ 2*cy
    expect(a.x + b.x).toBeCloseTo(600)
    expect(a.y + b.y).toBeCloseTo(400)
  })

  it('all sectors are at the specified radius from center', () => {
    const sectors = [
      { id: 'a', name: 'a', active: false },
      { id: 'b', name: 'b', active: false },
      { id: 'c', name: 'c', active: false },
    ]
    const cx = 400, cy = 300, radius = 150
    const result = computeSectorPositions(sectors, cx, cy, radius)
    for (const [, pos] of result) {
      const dist = Math.sqrt((pos.x - cx) ** 2 + (pos.y - cy) ** 2)
      expect(dist).toBeCloseTo(radius)
    }
  })
})
