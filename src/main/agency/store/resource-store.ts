import type Database from 'better-sqlite3';
import type { AgencyLeftover, ResourceKind, ResourceStatus } from '../../../shared/agency-jobs';

export type ResourceRecord = {
  id: number;
  jobId: number;
  kind: ResourceKind;
  member: string | null;
  path: string | null;
  branch: string | null;
  label: string;
  status: ResourceStatus;
  detail: string;
  attempts: number;
};

type ResourceRow = {
  id: number;
  job_id: number;
  kind: ResourceKind;
  member: string | null;
  path: string | null;
  branch: string | null;
  label: string;
  status: ResourceStatus;
  detail: string;
  attempts: number;
};

function toResource(row: ResourceRow): ResourceRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    member: row.member,
    path: row.path,
    branch: row.branch,
    label: row.label,
    status: row.status,
    detail: row.detail,
    attempts: row.attempts
  };
}

/**
 * What a job made that cleanup has to undo: worktrees, folders, Compose
 * projects, and crew panes that would not stop. A row is written before the
 * thing is made and moves to `cleaned`, `kept` or `failed` as cleanup runs.
 */
export class ResourceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  record(input: {
    jobId: number;
    kind: ResourceKind;
    label: string;
    member?: string | null;
    path?: string | null;
    branch?: string | null;
    status?: 'planned' | 'live' | 'failed';
    detail?: string;
  }): ResourceRecord {
    const at = this.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO job_resources (job_id, kind, member, path, branch, label, mode, status, detail,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'writable', ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.kind,
        input.member ?? null,
        input.path ?? null,
        input.branch ?? null,
        input.label,
        input.status ?? 'planned',
        input.detail ?? '',
        at,
        at
      );
    const row = this.get(Number(lastInsertRowid));
    if (!row) throw new Error('resource vanished on insert');
    return row;
  }

  get(id: number): ResourceRecord | null {
    const row = this.db
      .prepare<[number], ResourceRow>('SELECT * FROM job_resources WHERE id = ?')
      .get(id);
    return row ? toResource(row) : null;
  }

  /** Every resource of a job, oldest first. */
  forJob(jobId: number): ResourceRecord[] {
    return this.db
      .prepare<[number], ResourceRow>('SELECT * FROM job_resources WHERE job_id = ? ORDER BY id')
      .all(jobId)
      .map(toResource);
  }

  /** A cleanup attempt's outcome. A failure counts toward the automatic-retry cap. */
  settle(id: number, status: 'cleaned' | 'kept' | 'failed' | 'dismissed', detail = ''): void {
    this.db
      .prepare(
        `UPDATE job_resources SET status = ?, detail = ?, updated_at = ?,
           attempts = attempts + (CASE WHEN ? = 'failed' THEN 1 ELSE 0 END)
         WHERE id = ?`
      )
      .run(status, detail, this.now(), status, id);
  }

  /** Failed resources of every job that may still be retried on their own. */
  retryable(maxAttempts: number): ResourceRecord[] {
    return this.db
      .prepare<
        [number],
        ResourceRow
      >(`SELECT * FROM job_resources WHERE status = 'failed' AND attempts < ? ORDER BY id`)
      .all(maxAttempts)
      .map(toResource);
  }

  /** The folder a crew member works in, by its workspace id. */
  workspaceRoot(workspaceId: number): string | null {
    return (
      this.db
        .prepare<[number], { root: string }>('SELECT root FROM job_workspaces WHERE id = ?')
        .get(workspaceId)?.root ?? null
    );
  }

  /** A repository's kept and failed resources not dismissed, for the Leftovers list. */
  leftovers(repoId: string): AgencyLeftover[] {
    return this.db
      .prepare<[string], ResourceRow>(
        `SELECT r.* FROM job_resources r JOIN jobs j ON j.id = r.job_id
         WHERE j.repo_id = ? AND r.status IN ('kept', 'failed') ORDER BY r.id`
      )
      .all(repoId)
      .map((r) => ({
        id: r.id,
        jobId: r.job_id,
        kind: r.kind,
        label: r.label,
        path: r.path,
        status: r.status === 'kept' ? 'kept' : 'failed',
        detail: r.detail
      }));
  }
}
