import { describe, it, expect } from 'vitest'
import { mapSectors, mapCrew } from '../scene-utils'
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
