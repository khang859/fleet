import type Database from 'better-sqlite3'
import { statSync } from 'fs'
import type { ConfigService } from './config-service'

const TABLES = [
  'sectors',
  'supply_routes',
  'missions',
  'crew',
  'comms',
  'cargo',
  'ships_log',
  'starbase_config',
  'protocol_executions',
  'protocols',
  'protocol_steps',
] as const

export class RetentionService {
  constructor(
    private db: Database.Database,
    private configService: ConfigService,
    private dbPath: string
  ) {}

  cleanup(): { comms: number; cargo: number; shipsLog: number; crew: number; protocolExecutions: number } {
    const commsRetentionDays = (this.configService.get('comms_retention_days') as number) ?? 30
    const cargoRetentionDays = (this.configService.get('cargo_retention_days') as number) ?? 14
    const shipsLogRetentionDays =
      (this.configService.get('ships_log_retention_days') as number) ?? 30
    const crewRetentionDays = (this.configService.get('crew_retention_days') as number) ?? 7

    const commsResult = this.db
      .prepare(`DELETE FROM comms WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(commsRetentionDays)

    const cargoResult = this.db
      .prepare(`DELETE FROM cargo WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(cargoRetentionDays)

    const shipsLogResult = this.db
      .prepare(`DELETE FROM ships_log WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(shipsLogRetentionDays)

    const crewResult = this.db
      .prepare(
        `DELETE FROM crew
         WHERE status IN ('error', 'complete', 'timeout', 'lost', 'aborted', 'dismissed')
         AND updated_at < datetime('now', '-' || ? || ' days')`
      )
      .run(crewRetentionDays)

    const protocolExecutionsRetentionDays = (this.configService.get('protocol_executions_retention_days') as number) ?? 30

    const protocolExecutionsResult = this.db
      .prepare(`DELETE FROM protocol_executions WHERE status IN ('complete', 'failed', 'cancelled', 'gate-expired') AND created_at < datetime('now', '-' || ? || ' days')`)
      .run(protocolExecutionsRetentionDays)

    return {
      comms: commsResult.changes,
      cargo: cargoResult.changes,
      shipsLog: shipsLogResult.changes,
      crew: crewResult.changes,
      protocolExecutions: protocolExecutionsResult.changes
    }
  }

  vacuum(): void {
    this.db.exec('VACUUM')
  }

  getStats(): { tables: Record<string, number>; dbSizeBytes: number; dbPath: string } {
    const tables: Record<string, number> = {}

    for (const table of TABLES) {
      const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
        count: number
      }
      tables[table] = row.count
    }

    const dbSizeBytes = statSync(this.dbPath).size

    return { tables, dbSizeBytes, dbPath: this.dbPath }
  }
}
