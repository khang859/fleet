import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MissionService } from '../starbase/mission-service'
import { SectorService } from '../starbase/sector-service'
import { CommsService } from '../starbase/comms-service'
import { StarbaseDB } from '../starbase/db'
import type { EventBus } from '../event-bus'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'fleet-test-starbase-events')

let db: StarbaseDB
let sectorId: string

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  const wsDir = join(TEST_DIR, 'workspace')
  const sectorDir = join(wsDir, 'api')
  mkdirSync(sectorDir, { recursive: true })
  writeFileSync(join(sectorDir, 'index.ts'), '')
  execSync('git init && git checkout -b main', { cwd: sectorDir })
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: sectorDir })
  writeFileSync(join(sectorDir, 'README.md'), '# Test')
  execSync('git add -A && git commit -m "initial"', { cwd: sectorDir })

  // Create api2 directory as a git repo for SectorService tests
  const sector2Dir = join(wsDir, 'api2')
  mkdirSync(sector2Dir, { recursive: true })
  writeFileSync(join(sector2Dir, 'index.ts'), '')
  execSync('git init && git checkout -b main', { cwd: sector2Dir })
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: sector2Dir })
  writeFileSync(join(sector2Dir, 'README.md'), '# Test2')
  execSync('git add -A && git commit -m "initial"', { cwd: sector2Dir })

  const dbDir = join(TEST_DIR, 'starbases')
  db = new StarbaseDB(wsDir, dbDir)
  db.open()

  const sectorSvc = new SectorService(db.getDb(), wsDir)
  const sector = sectorSvc.addSector({ path: 'api' })
  sectorId = sector.id
})

afterEach(() => {
  db.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('starbase-changed event emission', () => {
  it('MissionService.addMission emits starbase-changed', () => {
    const mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus
    const missionSvc = new MissionService(db.getDb(), mockEventBus)

    missionSvc.addMission({
      sectorId,
      summary: 'test mission',
      prompt: 'do the thing',
    })

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'starbase-changed',
      { type: 'starbase-changed' },
    )
  })

  it('MissionService without eventBus does not throw', () => {
    const missionSvc = new MissionService(db.getDb())
    expect(() =>
      missionSvc.addMission({ sectorId, summary: 'test', prompt: 'test' })
    ).not.toThrow()
  })

  it('SectorService.addSector emits starbase-changed', () => {
    const mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus
    const sectorSvc = new SectorService(db.getDb(), join(TEST_DIR, 'workspace'), mockEventBus)

    sectorSvc.addSector({ path: 'api2' })

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'starbase-changed',
      { type: 'starbase-changed' },
    )
  })

  it('CommsService.send emits starbase-changed', () => {
    const mockEventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus
    const commsSvc = new CommsService(db.getDb(), mockEventBus)

    commsSvc.send({ from: 'test-crew', to: 'admiral', type: 'status', payload: '{}' })

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'starbase-changed',
      { type: 'starbase-changed' },
    )
  })
})
