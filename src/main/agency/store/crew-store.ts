import type Database from 'better-sqlite3';

/** The status a crew member has once its pane is gone for good. */
export const CREW_ENDED = 'ended';
/** Its pane opened, and its session has not reported yet. */
export const CREW_STARTING = 'starting';
/** Its session reported from its pane. */
export const CREW_LIVE = 'live';
/** Why a member a restart took ended; a hire for its step resumes it. */
export const LOST_AT_RESTART = 'lost at restart';

export type CrewRecord = {
  id: number;
  jobId: number;
  stepId: string;
  role: string;
  runtime: string;
  model: string | null;
  label: string;
  paneId: string | null;
  sessionId: string | null;
  workspaceId: number | null;
  status: string;
  replaces: number | null;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
};

type CrewRow = {
  id: number;
  job_id: number;
  step_id: string;
  role: string;
  runtime: string;
  model: string | null;
  label: string;
  pane_id: string | null;
  session_id: string | null;
  workspace_id: number | null;
  status: string;
  replaces: number | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
};

function toCrew(row: CrewRow): CrewRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    role: row.role,
    runtime: row.runtime,
    model: row.model,
    label: row.label,
    paneId: row.pane_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    status: row.status,
    replaces: row.replaces,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason
  };
}

/**
 * A job's crew members. A member not `ended` may still have a pane to stop;
 * an ended one keeps its row, spend and transcript link.
 */
export class CrewStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  insert(input: {
    jobId: number;
    stepId: string;
    role: string;
    runtime: string;
    model?: string | null;
    label: string;
    paneId?: string | null;
    sessionId?: string | null;
    workspaceId?: number | null;
    status: string;
    replaces?: number | null;
  }): CrewRecord {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO crew_members (job_id, step_id, role, runtime, model, label, pane_id, session_id,
           workspace_id, status, replaces, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.stepId,
        input.role,
        input.runtime,
        input.model ?? null,
        input.label,
        input.paneId ?? null,
        input.sessionId ?? null,
        input.workspaceId ?? null,
        input.status,
        input.replaces ?? null,
        this.now()
      );
    const crew = this.get(Number(lastInsertRowid));
    if (!crew) throw new Error('crew member vanished on insert');
    return crew;
  }

  get(id: number): CrewRecord | null {
    const row = this.db
      .prepare<[number], CrewRow>('SELECT * FROM crew_members WHERE id = ?')
      .get(id);
    return row ? toCrew(row) : null;
  }

  /** Crew members not ended yet, for one job or every job. */
  live(jobId?: number): CrewRecord[] {
    const rows =
      jobId === undefined
        ? this.db
            .prepare<[string], CrewRow>('SELECT * FROM crew_members WHERE status != ? ORDER BY id')
            .all(CREW_ENDED)
        : this.db
            .prepare<
              [number, string],
              CrewRow
            >('SELECT * FROM crew_members WHERE job_id = ? AND status != ? ORDER BY id')
            .all(jobId, CREW_ENDED);
    return rows.map(toCrew);
  }

  /** Every crew member a job has hired, ended ones too, oldest first. */
  all(jobId: number): CrewRecord[] {
    return this.db
      .prepare<[number], CrewRow>('SELECT * FROM crew_members WHERE job_id = ? ORDER BY id')
      .all(jobId)
      .map(toCrew);
  }

  /** A member's session reported: it is live, on the session its pane runs now. */
  reported(id: number, sessionId: string): void {
    this.db
      .prepare('UPDATE crew_members SET status = ?, session_id = ? WHERE id = ? AND status != ?')
      .run(CREW_LIVE, sessionId, id, CREW_ENDED);
  }

  end(id: number, reason: string): void {
    this.db
      .prepare(
        'UPDATE crew_members SET status = ?, ended_at = ?, end_reason = ? WHERE id = ? AND status != ?'
      )
      .run(CREW_ENDED, this.now(), reason, id, CREW_ENDED);
  }
}
