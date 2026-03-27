import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus';

type MissionRow = {
  id: number;
  sector_id: string;
  crew_id: string | null;
  summary: string;
  prompt: string;
  acceptance_criteria: string | null;
  status: string;
  type: string;
  priority: number;
  depends_on_mission_id: number | null;
  result: string | null;
  verify_result: string | null;
  review_verdict: string | null;
  review_notes: string | null;
  review_round: number;
  pr_branch: string | null;
  original_mission_id: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AddMissionOpts = {
  sectorId: string;
  summary: string;
  prompt: string;
  acceptanceCriteria?: string;
  priority?: number;
  dependsOnMissionIds?: number[];
  type?: string;
  prBranch?: string;
  originalMissionId?: number;
};

type ListMissionsFilter = {
  sectorId?: string;
  status?: string;
};

export class MissionService {
  constructor(
    private db: Database.Database,
    private eventBus?: EventBus
  ) {}

  addMission(opts: AddMissionOpts): MissionRow {
    const result = this.db
      .prepare(
        `INSERT INTO missions (sector_id, summary, prompt, acceptance_criteria, priority, depends_on_mission_id, type, pr_branch, original_mission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.sectorId,
        opts.summary,
        opts.prompt,
        opts.acceptanceCriteria ?? null,
        opts.priority ?? 0,
        null,
        opts.type ?? 'code',
        opts.prBranch ?? null,
        opts.originalMissionId ?? null
      );

    const mission = this.getMission(Number(result.lastInsertRowid));
    if (!mission) throw new Error('Failed to retrieve inserted mission');

    for (const depId of opts.dependsOnMissionIds ?? []) {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO mission_dependencies (mission_id, depends_on_mission_id) VALUES (?, ?)'
        )
        .run(result.lastInsertRowid, depId);
    }

    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
    return mission;
  }

  completeMission(missionId: number, result: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'awaiting-cargo-check', cargo_checked = 0, result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(result, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  failMission(missionId: number, reason: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(reason, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  abortMission(missionId: number): void {
    this.db
      .prepare("UPDATE missions SET status = 'aborted' WHERE id = ? AND status = 'queued'")
      .run(missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  activateMission(missionId: number, crewId: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'active', crew_id = ?, started_at = datetime('now') WHERE id = ?"
      )
      .run(crewId, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  setStatus(missionId: number, status: string): void {
    this.db.prepare('UPDATE missions SET status = ? WHERE id = ?').run(status, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  escalateMission(missionId: number, reason: string): void {
    this.db
      .prepare(
        "UPDATE missions SET status = 'escalated', crew_id = NULL, result = ?, completed_at = datetime('now') WHERE id = ?"
      )
      .run(reason, missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  getMission(missionId: number): MissionRow | undefined {
    return this.db
      .prepare<[number], MissionRow>('SELECT * FROM missions WHERE id = ?')
      .get(missionId);
  }

  listMissions(filter?: ListMissionsFilter): MissionRow[] {
    let sql = 'SELECT * FROM missions WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.sectorId) {
      sql += ' AND sector_id = ?';
      params.push(filter.sectorId);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY priority ASC, created_at ASC';
    return this.db.prepare<unknown[], MissionRow>(sql).all(...params);
  }

  nextMission(sectorId: string): MissionRow | undefined {
    return this.db
      .prepare<[string], MissionRow>(
        `SELECT * FROM missions
         WHERE sector_id = ? AND status = 'queued'
         AND (
           NOT EXISTS (
             SELECT 1 FROM mission_dependencies WHERE mission_id = missions.id
           )
           OR NOT EXISTS (
             SELECT 1 FROM mission_dependencies md
             JOIN missions dep ON dep.id = md.depends_on_mission_id
             WHERE md.mission_id = missions.id
               AND dep.status NOT IN ('completed', 'failed', 'aborted')
           )
         )
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`
      )
      .get(sectorId);
  }

  getDependencies(missionId: number): MissionRow[] {
    return this.db
      .prepare<[number], MissionRow>(
        `SELECT m.* FROM missions m
         JOIN mission_dependencies md ON md.depends_on_mission_id = m.id
         WHERE md.mission_id = ?`
      )
      .all(missionId);
  }

  getDependents(missionId: number): MissionRow[] {
    return this.db
      .prepare<[number], MissionRow>(
        `SELECT m.* FROM missions m
         JOIN mission_dependencies md ON md.mission_id = m.id
         WHERE md.depends_on_mission_id = ?`
      )
      .all(missionId);
  }

  /** Reset crew assignment and timestamps so the mission can be re-deployed */
  resetForRequeue(missionId: number): void {
    this.db
      .prepare(
        "UPDATE missions SET crew_id = NULL, status = 'queued', started_at = NULL, completed_at = NULL, result = NULL, verify_result = NULL WHERE id = ?"
      )
      .run(missionId);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }

  setReviewVerdict(missionId: number, verdict: string, notes: string): void {
    this.db
      .prepare('UPDATE missions SET review_verdict = ?, review_notes = ? WHERE id = ?')
      .run(verdict, notes, missionId);
  }

  setPrBranch(missionId: number, prBranch: string): void {
    this.db.prepare('UPDATE missions SET pr_branch = ? WHERE id = ?').run(prBranch, missionId);
  }

  updateMission(
    missionId: number,
    fields: Partial<Pick<MissionRow, 'summary' | 'prompt' | 'priority' | 'acceptance_criteria'>>
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }

    if (sets.length === 0) return;
    values.push(missionId);

    this.db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    this.eventBus?.emit('starbase-changed', { type: 'starbase-changed' });
  }
}
