import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StarbaseDB } from '../starbase/db'
import { ConfigService } from '../starbase/config-service'
import { RetentionService } from '../starbase/retention-service'
import { rmSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'fleet-test-retention')
const DB_DIR = join(TEST_DIR, 'starbases')

let starbaseDb: StarbaseDB
let configService: ConfigService
let retentionService: RetentionService

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  starbaseDb = new StarbaseDB('/tmp/retention-test', DB_DIR)
  starbaseDb.open()
  configService = new ConfigService(starbaseDb.getDb())
  retentionService = new RetentionService(starbaseDb.getDb(), configService, starbaseDb.getDbPath())
})

afterEach(() => {
  starbaseDb.close()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('RetentionService', () => {
  describe('cleanup', () => {
    it('should delete comms older than configured retention days', () => {
      const db = starbaseDb.getDb()
      // Insert old comms (35 days ago) and recent comms
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'crew2', 'text', '{}', '-35 days')
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'crew2', 'text', '{}', '-1 days')

      const result = retentionService.cleanup()
      expect(result.comms).toBe(1)

      const remaining = db.prepare('SELECT COUNT(*) as count FROM comms').get() as {
        count: number
      }
      expect(remaining.count).toBe(1)
    })

    it('should delete cargo older than configured retention days', () => {
      const db = starbaseDb.getDb()
      // Need a sector for cargo FK
      db.prepare('INSERT INTO sectors (id, name, root_path) VALUES (?, ?, ?)').run(
        's1',
        'test',
        '/tmp/test-sector'
      )

      db.prepare(
        "INSERT INTO cargo (crew_id, sector_id, type, manifest, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 's1', 'patch', '{}', '-20 days')
      db.prepare(
        "INSERT INTO cargo (crew_id, sector_id, type, manifest, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 's1', 'patch', '{}', '-1 days')

      const result = retentionService.cleanup()
      expect(result.cargo).toBe(1)
    })

    it('should delete ships_log older than configured retention days', () => {
      const db = starbaseDb.getDb()
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail, created_at) VALUES (?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'deploy', 'old entry', '-35 days')
      db.prepare(
        "INSERT INTO ships_log (crew_id, event_type, detail, created_at) VALUES (?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'deploy', 'recent entry', '-1 days')

      const result = retentionService.cleanup()
      expect(result.shipsLog).toBe(1)
    })

    it('should respect custom retention config', () => {
      const db = starbaseDb.getDb()
      configService.set('comms_retention_days', 5)

      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'crew2', 'text', '{}', '-10 days')
      db.prepare(
        "INSERT INTO comms (from_crew, to_crew, type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
      ).run('crew1', 'crew2', 'text', '{}', '-3 days')

      const result = retentionService.cleanup()
      expect(result.comms).toBe(1)
    })

    it('should return zero counts when nothing to clean', () => {
      const result = retentionService.cleanup()
      expect(result.comms).toBe(0)
      expect(result.cargo).toBe(0)
      expect(result.shipsLog).toBe(0)
    })
  })

  describe('vacuum', () => {
    it('should run VACUUM without error', () => {
      expect(() => retentionService.vacuum()).not.toThrow()
    })
  })

  describe('getStats', () => {
    it('should return row counts for all tables', () => {
      const stats = retentionService.getStats()
      expect(stats.tables).toHaveProperty('sectors')
      expect(stats.tables).toHaveProperty('supply_routes')
      expect(stats.tables).toHaveProperty('missions')
      expect(stats.tables).toHaveProperty('crew')
      expect(stats.tables).toHaveProperty('comms')
      expect(stats.tables).toHaveProperty('cargo')
      expect(stats.tables).toHaveProperty('ships_log')
      expect(stats.tables).toHaveProperty('starbase_config')

      // All should be zero or have seeded config rows
      expect(stats.tables.sectors).toBe(0)
      expect(stats.tables.starbase_config).toBeGreaterThan(0)
    })

    it('should return db size and path', () => {
      const stats = retentionService.getStats()
      expect(stats.dbSizeBytes).toBeGreaterThan(0)
      expect(stats.dbPath).toBe(starbaseDb.getDbPath())
    })

    it('should reflect inserted rows', () => {
      const db = starbaseDb.getDb()
      db.prepare('INSERT INTO sectors (id, name, root_path) VALUES (?, ?, ?)').run(
        's1',
        'test',
        '/tmp/test-sector'
      )

      const stats = retentionService.getStats()
      expect(stats.tables.sectors).toBe(1)
    })
  })
})
