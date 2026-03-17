import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StarbaseDB } from '../starbase/db'
import { SectorService } from '../starbase/sector-service'
import { MissionService } from '../starbase/mission-service'
import { CommsService } from '../starbase/comms-service'
import { dispatchTool } from '../starbase/admiral-tools'
import type { AdmiralToolDeps } from '../starbase/admiral-tools'
import { rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'fleet-test-admiral-tools')
let db: StarbaseDB
let sectorService: SectorService
let missionService: MissionService
let commsService: CommsService
let deps: AdmiralToolDeps

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  db = new StarbaseDB('/tmp/admiral-tools-test', join(TEST_DIR, 'starbases'))
  db.open()

  const raw = db.getDb()
  sectorService = new SectorService(raw, TEST_DIR)
  missionService = new MissionService(raw)
  commsService = new CommsService(raw)

  deps = {
    sectorService,
    missionService,
    crewService: {
      listCrew: () => [],
      observeCrew: () => 'some output',
      recallCrew: () => {},
      deployCrew: async () => ({ crewId: 'test-crew-1234', tabId: 'tab-1', missionId: 1 })
    } as unknown as AdmiralToolDeps['crewService'],
    commsService,
    ptyManager: {} as AdmiralToolDeps['ptyManager'],
    createTab: () => 'tab-1'
  }
})

afterEach(() => {
  db.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('dispatchTool', () => {
  it('should list sectors (empty)', async () => {
    const result = await dispatchTool('sectors', {}, deps)
    expect(JSON.parse(result)).toEqual([])
  })

  it('should add a mission and list it', async () => {
    // Create a sector directory first
    const sectorDir = join(TEST_DIR, 'my-project')
    mkdirSync(sectorDir, { recursive: true })
    require('fs').writeFileSync(join(sectorDir, 'package.json'), '{}')
    require('child_process').execSync(
      'git init && git add . && git commit -m "init" --allow-empty',
      {
        cwd: sectorDir
      }
    )

    const addResult = await dispatchTool('add_sector', { path: sectorDir }, deps)
    const sector = JSON.parse(addResult)
    expect(sector.id).toBeTruthy()

    const missionResult = await dispatchTool(
      'add_mission',
      { sector_id: sector.id, summary: 'Fix bug', prompt: 'Fix the login bug in auth.ts' },
      deps
    )
    const mission = JSON.parse(missionResult)
    expect(mission.id).toBeGreaterThan(0)
    expect(mission.status).toBe('queued')

    const listResult = await dispatchTool('missions', { sector_id: sector.id }, deps)
    const missions = JSON.parse(listResult)
    expect(missions).toHaveLength(1)
  })

  it('should handle hail and inbox', async () => {
    const hailResult = await dispatchTool('hail', { to: 'crew-1', message: 'Status report?' }, deps)
    expect(JSON.parse(hailResult).transmissionId).toBeGreaterThan(0)

    // inbox returns unread for admiral — the hail was FROM admiral, so inbox is empty
    const inboxResult = await dispatchTool('inbox', {}, deps)
    expect(JSON.parse(inboxResult)).toHaveLength(0)

    // Send a hail TO admiral
    commsService.send({ from: 'crew-1', to: 'admiral', type: 'hailing', payload: 'Need help' })
    const inboxResult2 = await dispatchTool('inbox', {}, deps)
    expect(JSON.parse(inboxResult2)).toHaveLength(1)
  })

  it('should resolve a transmission', async () => {
    const id = commsService.send({
      from: 'crew-1',
      to: 'admiral',
      type: 'hailing',
      payload: 'Help me'
    })
    const result = await dispatchTool(
      'resolve',
      { transmission_id: id, response: 'Here is help' },
      deps
    )
    expect(JSON.parse(result).replyTransmissionId).toBeGreaterThan(0)

    // Original should be marked read
    const unread = commsService.getUnread('admiral')
    expect(unread).toHaveLength(0)
  })

  it('should observe crew', async () => {
    const result = await dispatchTool('observe', { crew_id: 'test-crew' }, deps)
    expect(result).toBe('some output')
  })

  it('should return deferred message for ask', async () => {
    const result = await dispatchTool('ask', { crew_id: 'crew-1', question: 'What?' }, deps)
    expect(JSON.parse(result).error).toContain('not yet implemented')
  })

  it('should return error when supply route service not initialized', async () => {
    const result = await dispatchTool(
      'add_supply_route',
      { upstream_sector_id: 'a', downstream_sector_id: 'b' },
      deps
    )
    expect(JSON.parse(result).error).toContain('not initialized')
  })

  it('should return error for unknown tool', async () => {
    const result = await dispatchTool('nonexistent', {}, deps)
    expect(JSON.parse(result).error).toContain('Unknown tool')
  })

  it('should deploy via crew service', async () => {
    const result = await dispatchTool('deploy', { sector_id: 'my-sector', prompt: 'Fix it' }, deps)
    const parsed = JSON.parse(result)
    expect(parsed.crewId).toBe('test-crew-1234')
    expect(parsed.tabId).toBe('tab-1')
  })

  it('should recall crew', async () => {
    const result = await dispatchTool('recall', { crew_id: 'test-crew' }, deps)
    expect(JSON.parse(result).recalled).toBe('test-crew')
  })
})
