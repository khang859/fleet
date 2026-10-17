import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  FILE_RESULT_KINDS,
  type AgencyMergeRun,
  type AgencyResult,
  type PrState,
  type ResultBody,
  type ResultMergeStatus
} from '../../../shared/agency-jobs';
import type { DeliverableKind } from '../../../shared/agency-plan';
import { parseJsonAs } from '../../../shared/parse-json';

const PrStateSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  branch: z.string(),
  base: z.string(),
  headSha: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  draft: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  checks: z.object({ passed: z.number(), failed: z.number(), pending: z.number() })
}) satisfies z.ZodType<PrState>;

const ResultBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), pr: PrStateSchema }),
  z.object({ kind: z.literal('branch'), branch: z.string(), sha: z.string() }),
  z.object({ kind: z.literal('copy'), text: z.string() }),
  z.object({ kind: z.enum(['preview', 'link']), url: z.string() }),
  z.object({
    kind: z.enum(FILE_RESULT_KINDS),
    files: z.array(
      z.object({ name: z.string(), path: z.string(), type: z.string(), size: z.number() })
    )
  })
]) satisfies z.ZodType<ResultBody>;

/** What a row whose JSON no longer reads shows: its title, with nothing to open. */
const UNREADABLE: ResultBody = { kind: 'copy', text: 'This result could not be read.' };

type ResultRow = {
  id: number;
  job_id: number;
  step_id: string;
  kind: DeliverableKind;
  label: string;
  listed: number;
  title: string;
  member: string | null;
  data_json: string;
  head_sha: string | null;
  observed_json: string | null;
  observed_at: number | null;
  delivered_at: number;
  merge_status: ResultMergeStatus | null;
  merge_sha: string | null;
};

type MergeRunRow = {
  status: AgencyMergeRun['status'];
  note: string;
  since: number | null;
  rerun_at: number | null;
};

/** A job's merge run as the queue reads it: when the last merge was, and when it asked for checks again. */
export type MergeRunRecord = AgencyMergeRun & { since: number | null; rerunAt: number | null };

/**
 * A PR shows as GitHub last reported it, so a force-push shows its new diff
 * stat, and is marked once its head is not the one that was delivered.
 */
function toResult(row: ResultRow): AgencyResult {
  const delivered = parseJsonAs(ResultBodySchema, row.data_json) ?? UNREADABLE;
  const observed = parseJsonAs(PrStateSchema, row.observed_json);
  const body: ResultBody =
    delivered.kind === 'pr' && observed !== null ? { kind: 'pr', pr: observed } : delivered;
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    kind: row.kind,
    label: row.label,
    listed: row.listed === 1,
    title: row.title,
    body,
    changedAfterDelivery: observed !== null && observed.headSha !== row.head_sha,
    deliveredAt: row.delivered_at,
    member: row.member,
    merge: row.merge_status === null ? null : { status: row.merge_status, sha: row.merge_sha }
  };
}

/** What a job's steps handed back, one row per result card. */
export class ResultStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  insert(input: {
    jobId: number;
    stepId: string;
    planVersion: number;
    label: string;
    listed: boolean;
    title: string;
    member: string | null;
    body: ResultBody;
  }): AgencyResult {
    const ref = resultRef(input.body);
    const headSha = input.body.kind === 'pr' ? input.body.pr.headSha : null;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO results (job_id, step_id, plan_version, kind, label, listed, title, member,
           ref, data_json, head_sha, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.stepId,
        input.planVersion,
        input.body.kind,
        input.label,
        input.listed ? 1 : 0,
        input.title,
        input.member,
        ref,
        JSON.stringify(input.body),
        headSha,
        this.now()
      );
    const result = this.get(Number(lastInsertRowid));
    if (result === null) throw new Error('A result was written and could not be read back.');
    return result;
  }

  get(id: number): AgencyResult | null {
    const row = this.db.prepare<[number], ResultRow>('SELECT * FROM results WHERE id = ?').get(id);
    return row ? toResult(row) : null;
  }

  forJob(jobId: number): AgencyResult[] {
    return this.db
      .prepare<[number], ResultRow>('SELECT * FROM results WHERE job_id = ? ORDER BY id')
      .all(jobId)
      .map(toResult);
  }

  /** The job's PR results not refreshed within `maxAgeMs`. */
  stalePrs(jobId: number, maxAgeMs: number): Array<{ id: number; url: string }> {
    return this.db
      .prepare<[number, number], { id: number; ref: string }>(
        `SELECT id, ref FROM results
         WHERE job_id = ? AND kind = 'pr' AND (observed_at IS NULL OR observed_at <= ?)
         ORDER BY id`
      )
      .all(jobId, this.now() - maxAgeMs)
      .map((r) => ({ id: r.id, url: r.ref }));
  }

  /** Record what GitHub says about a PR result now. Returns whether anything changed. */
  observe(id: number, pr: PrState): boolean {
    const json = JSON.stringify(pr);
    const before = this.db
      .prepare<
        [number],
        { observed_json: string | null }
      >('SELECT observed_json FROM results WHERE id = ?')
      .get(id);
    this.db
      .prepare('UPDATE results SET observed_json = ?, observed_at = ? WHERE id = ?')
      .run(json, this.now(), id);
    return before?.observed_json !== json;
  }
}

/**
 * A job's merge: which PR results go in which order, how each stands, and
 * the run that walks them. The queue reads and moves it; the job sheet shows it.
 */
export class MergeStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  /** Start, or start again, a job's merge with its PR results in `order`. */
  begin(jobId: number, order: number[]): void {
    this.db.transaction(() => {
      const place = this.db.prepare(
        `UPDATE results SET merge_position = ?,
           merge_status = CASE WHEN merge_status = 'merged' THEN 'merged' ELSE 'queued' END
         WHERE id = ? AND job_id = ?`
      );
      order.forEach((id, i) => place.run(i, id, jobId));
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO merge_runs (job_id, status, note, since, rerun_at, started_at, updated_at)
           VALUES (?, 'running', '', NULL, NULL, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET status = 'running', note = '', rerun_at = NULL,
             updated_at = excluded.updated_at`
        )
        .run(jobId, at, at);
    })();
  }

  /** Put a result at the end of a running merge, as the umbrella bump PR goes last. */
  append(jobId: number, resultId: number): void {
    this.db
      .prepare(
        `UPDATE results SET merge_status = 'queued', merge_position =
           (SELECT COALESCE(MAX(merge_position), -1) + 1 FROM results WHERE job_id = ?)
         WHERE id = ?`
      )
      .run(jobId, resultId);
  }

  /** The job's PR results in the merge, in merge order. */
  queue(jobId: number): Array<{ id: number; status: ResultMergeStatus }> {
    return this.db
      .prepare<[number], { id: number; merge_status: ResultMergeStatus }>(
        `SELECT id, merge_status FROM results
         WHERE job_id = ? AND merge_status IS NOT NULL ORDER BY merge_position`
      )
      .all(jobId)
      .map((r) => ({ id: r.id, status: r.merge_status }));
  }

  /** A PR merged: its merged commit, and the time the next PR's checks must be newer than. */
  merged(resultId: number, jobId: number, sha: string | null): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE results SET merge_status = 'merged', merge_sha = ? WHERE id = ?`)
        .run(sha, resultId);
      this.db
        .prepare(
          'UPDATE merge_runs SET since = ?, rerun_at = NULL, updated_at = ? WHERE job_id = ?'
        )
        .run(this.now(), this.now(), jobId);
    })();
  }

  run(jobId: number): MergeRunRecord | null {
    const row = this.db
      .prepare<[number], MergeRunRow>('SELECT * FROM merge_runs WHERE job_id = ?')
      .get(jobId);
    return row
      ? { status: row.status, note: row.note, since: row.since, rerunAt: row.rerun_at }
      : null;
  }

  /** Jobs whose merge is under way, for the queue to move on after a restart. */
  running(): number[] {
    return this.db
      .prepare<[], { job_id: number }>(`SELECT job_id FROM merge_runs WHERE status = 'running'`)
      .all()
      .map((r) => r.job_id);
  }

  /** What the run waits on now; `rerun` marks that checks were asked to run again. */
  waiting(jobId: number, note: string, opts: { rerun?: boolean } = {}): void {
    this.db
      .prepare(
        `UPDATE merge_runs SET note = ?, updated_at = ?,
           rerun_at = CASE WHEN ? THEN ? ELSE rerun_at END
         WHERE job_id = ?`
      )
      .run(note, this.now(), opts.rerun === true ? 1 : 0, this.now(), jobId);
  }

  /** The run ends: every PR merged, or one could not be. */
  finish(jobId: number, status: 'done' | 'failed', note: string, failed?: number): void {
    this.db.transaction(() => {
      if (failed !== undefined) {
        this.db.prepare(`UPDATE results SET merge_status = 'failed' WHERE id = ?`).run(failed);
      }
      this.db
        .prepare('UPDATE merge_runs SET status = ?, note = ?, updated_at = ? WHERE job_id = ?')
        .run(status, note, this.now(), jobId);
    })();
  }
}

/** The one string a result points at: its PR or link, its branch, or its first file. */
function resultRef(body: ResultBody): string {
  switch (body.kind) {
    case 'pr':
      return body.pr.url;
    case 'branch':
      return body.branch;
    case 'copy':
      return '';
    case 'preview':
    case 'link':
      return body.url;
    case 'doc':
    case 'image':
    case 'review':
    case 'report':
    case 'file':
      return body.files[0]?.path ?? '';
  }
}
