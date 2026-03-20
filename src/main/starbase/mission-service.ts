import type Database from 'better-sqlite3'
import type { EventBus } from '../event-bus'

type MissionRow = {
  id: number
  sector_id: string
  crew_id: string | null
  summary: string
  prompt: string
  acceptance_criteria: string | null
  status: string
  type: string
  priority: number
  depends_on_mission_id: number | null
  result: string | null
  verify_result: string | null
  review_verdict: string | null
  review_notes: string | null
  review_round: number
  pr_branch: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

type AddMissionOpts = {
  sectorId: string
  summary: string
  prompt: string
  acceptanceCriteria?: string
  priority?: number
  dependsOnMissionId?: number
  type?: string
  prBranch?: string
}

type ListMissionsFilter = {
  sectorId?: string
  status?: string
}

export class MissionService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus,
  ) {}

  addMission(opts: AddMissionOpts): MissionRow {
    const result = this.db
      .prepare(
        `INSERT INTO missions (sector_id, summary, prompt, acceptance_criteria, priority, depends_on_mission_id, type, pr_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.sectorId,
        opts.summary,
        opts.prompt,
        opts.acceptanceCriteria ?? null,
        opts.priority ?? 0,
        opts.dependsOnMissionId ?? null,
        opts.type ?? 'code',
        opts.prBranch ?? null
      )

    const mission = this.getMission(result.lastInsertRowid as number)!
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
    return mission
  }

  completeMission(missionId: number, result: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(result, missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  failMission(missionId: number, reason: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(reason, missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  abortMission(missionId: number): void {
    this.db
      .prepare("UPDATE missions SET status = 'aborted' WHERE id = ? AND status = 'queued'")
      .run(missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  activateMission(missionId: number, crewId: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?"
      )
      .run(crewId, missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  setStatus(missionId: number, status: string): void {
    this.db.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  getMission(missionId: number): MissionRow | undefined {
    return this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as
      | MissionRow
      | undefined
  }

  listMissions(filter?: ListMissionsFilter): MissionRow[] {
    let sql = 'SELECT * FROM missions WHERE 1=1'
    const params: unknown[] = []

    if (filter?.sectorId) {
      sql += ' AND sector_id = ?'
      params.push(filter.sectorId)
    }
    if (filter?.status) {
      sql += ' AND status = ?'
      params.push(filter.status)
    }

    sql += ' ORDER BY priority ASC, created_at ASC'
    return this.db.prepare(sql).all(...params) as MissionRow[]
  }

  nextMission(sectorId: string): MissionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM missions
         WHERE sector_id = ? AND status = 'queued'
         AND (depends_on_mission_id IS NULL
              OR depends_on_mission_id IN (SELECT id FROM missions WHERE status = 'completed'))
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`
      )
      .get(sectorId) as MissionRow | undefined
  }

  /** Reset crew assignment and timestamps so the mission can be re-deployed */
  resetForRequeue(missionId: number): void {
    this.db
      .prepare(
        'UPDATE missions SET crew_id = NULL, started_at = NULL, completed_at = NULL, result = NULL WHERE id = ?'
      )
      .run(missionId)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }

  setReviewVerdict(missionId: number, verdict: string, notes: string): void {
    this.db
      .prepare('UPDATE missions SET review_verdict = ?, review_notes = ? WHERE id = ?')
      .run(verdict, notes, missionId)
  }

  setPrBranch(missionId: number, prBranch: string): void {
    this.db
      .prepare('UPDATE missions SET pr_branch = ? WHERE id = ?')
      .run(prBranch, missionId)
  }

  updateMission(
    missionId: number,
    fields: Partial<Pick<MissionRow, 'summary' | 'prompt' | 'priority' | 'acceptance_criteria'>>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`)
        values.push(value)
      }
    }

    if (sets.length === 0) return
    values.push(missionId)

    this.db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' })
  }
}
