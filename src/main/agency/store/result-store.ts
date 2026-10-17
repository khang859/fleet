import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  FILE_RESULT_KINDS,
  type AgencyResult,
  type PrState,
  type ResultBody
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
  data_json: string;
  head_sha: string | null;
  observed_json: string | null;
  observed_at: number | null;
  delivered_at: number;
};

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
    deliveredAt: row.delivered_at
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
    body: ResultBody;
  }): AgencyResult {
    const ref = resultRef(input.body);
    const headSha = input.body.kind === 'pr' ? input.body.pr.headSha : null;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO results (job_id, step_id, plan_version, kind, label, listed, title, ref,
           data_json, head_sha, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        input.stepId,
        input.planVersion,
        input.body.kind,
        input.label,
        input.listed ? 1 : 0,
        input.title,
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
