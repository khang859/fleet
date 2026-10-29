import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  NO_PLAN_CHECKS,
  PLAN_ISSUE_SEVERITIES,
  type AgencyJobLogEntry,
  type AgencyStep,
  type PlanBases,
  type PlanChecks,
  type PlanUse,
  type PlanVersionStatus,
  type StepStatus
} from '../../../shared/agency-jobs';
import { CrewSnapshotSchema, type CrewSnapshot } from '../../../shared/agency-crew';
import { PlanSchema, type Plan } from '../../../shared/agency-plan';
import { parseJsonAs } from '../../../shared/parse-json';

type VersionRow = {
  id: number;
  job_id: number;
  version: number;
  status: string;
  kind: string;
  author: string;
  parent_version: number | null;
  plan_json: string;
  checks_json: string;
  bases_json: string | null;
  snapshot_json: string;
  effects_json: string | null;
  decision_note: string | null;
  proposed_at: number;
  decided_at: number | null;
  uses_json: string;
  auto_start_usd: number | null;
};

type StepRow = {
  job_id: number;
  step_id: string;
  role: string;
  position: number;
  status: string;
  added_in: number;
  removed_in: number | null;
  branch_seq: number;
  note: string;
  updated_at: number;
  finished_at: number | null;
};

/** A plan version as stored: the plan the client saw, and how it was decided. */
export type PlanVersionRecord = {
  id: number;
  jobId: number;
  version: number;
  status: PlanVersionStatus;
  kind: 'initial' | 'change';
  author: 'admiral' | 'client';
  parentVersion: number | null;
  plan: Plan;
  checks: PlanChecks;
  bases: PlanBases | null;
  /** The roles and playbook as approved; null before approval or without a crew. */
  crew: CrewSnapshot | null;
  /** What approving it did, written before the effects ran. */
  effects: AppliedEffects | null;
  decisionNote: string | null;
  proposedAt: number;
  decidedAt: number | null;
  /** The saved preference lines the plan follows, as they read when it went up. */
  uses: PlanUse[];
  /** The dollar limit Fleet approved it under, on its own by the project's trust level; null when the client approved it. */
  autoStartUsd: number | null;
};

/** What an approval stopped and withdrew, kept so a restart can finish the job. */
export type AppliedEffects = {
  stopCrewIds: number[];
  withdrawnQuestionIds: number[];
  swaps: Record<string, 'continue' | 'restart'>;
};

const STATUSES: readonly PlanVersionStatus[] = [
  'proposed',
  'approved',
  'rejected',
  'replaced',
  'superseded'
];
/** Every step status, as a record so a new status cannot be left out and read back as pending. */
const STEP_STATUSES: Record<StepStatus, true> = {
  pending: true,
  queued: true,
  running: true,
  blocked: true,
  interrupted: true,
  stopped: true,
  failed: true,
  done: true,
  removed: true
};
const isStepStatus = (s: string): s is StepStatus => Object.hasOwn(STEP_STATUSES, s);

const IssueSchema = z.object({
  code: z.string(),
  severity: z.enum(PLAN_ISSUE_SEVERITIES),
  text: z.string(),
  step: z.string().optional(),
  member: z.string().optional(),
  fix: z.enum(['use-branch', 'trust-claude']).optional(),
  path: z.string().optional()
});
const PinSchema = z.object({ sha: z.string(), from: z.enum(['default', 'head']) });
const ChecksSchema = z.object({
  issues: z.array(IssueSchema),
  overlap: z.array(
    z.object({ jobId: z.number(), member: z.string(), path: z.string(), step: z.string() })
  ),
  bases: z
    .array(
      z.object({
        member: z.string(),
        defaultBranch: z.string().nullable(),
        defaultSha: z.string().nullable(),
        headBranch: z.string().nullable(),
        headSha: z.string().nullable(),
        pinned: PinSchema.nullable()
      })
    )
    .default([]),
  // Checks saved before env files were given to crew have none.
  envFiles: z.array(z.object({ stepId: z.string(), files: z.array(z.string()) })).default([])
});
const BasesSchema = z.record(z.string(), PinSchema);
const UsesSchema = z.array(
  z.object({ id: z.string(), layer: z.enum(['you', 'project']), text: z.string() })
);
const EffectsSchema = z.object({
  stopCrewIds: z.array(z.number()),
  withdrawnQuestionIds: z.array(z.number()),
  swaps: z.record(z.string(), z.enum(['continue', 'restart']))
});

/** Plans that would not parse are kept out of every read rather than crash it. */
const EMPTY_PLAN: Plan = {
  playbook: 'unknown',
  summary: 'This plan could not be read.',
  steps: [],
  budget: { usd: 0 },
  queueBehind: null,
  asksFirst: [],
  newRoles: [],
  uses: []
};

function toVersion(row: VersionRow): PlanVersionRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    version: row.version,
    status: STATUSES.find((s) => s === row.status) ?? 'replaced',
    kind: row.kind === 'change' ? 'change' : 'initial',
    author: row.author === 'client' ? 'client' : 'admiral',
    parentVersion: row.parent_version,
    plan: parseJsonAs(PlanSchema, row.plan_json) ?? EMPTY_PLAN,
    checks: parseJsonAs(ChecksSchema, row.checks_json) ?? NO_PLAN_CHECKS,
    bases: parseJsonAs(BasesSchema, row.bases_json),
    crew: parseJsonAs(CrewSnapshotSchema, row.snapshot_json),
    effects: parseJsonAs(EffectsSchema, row.effects_json),
    decisionNote: row.decision_note,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at,
    uses: parseJsonAs(UsesSchema, row.uses_json) ?? [],
    autoStartUsd: row.auto_start_usd
  };
}

function toStep(row: StepRow): AgencyStep {
  return {
    jobId: row.job_id,
    id: row.step_id,
    role: row.role,
    position: row.position,
    status: isStepStatus(row.status) ? row.status : 'pending',
    addedIn: row.added_in,
    removedIn: row.removed_in,
    note: row.note,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

/**
 * Plan versions, the steps they run, and the job's record. A version's plan is
 * never rewritten once stored: an edit is a new version.
 */
export class PlanStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  // ── Versions ─────────────────────────────────────────────────────────────

  insertVersion(input: {
    jobId: number;
    kind: 'initial' | 'change';
    author: 'admiral' | 'client';
    parentVersion: number | null;
    plan: Plan;
    checks: PlanChecks;
    uses?: PlanUse[];
  }): PlanVersionRecord {
    const next =
      (this.db
        .prepare<
          [number],
          { v: number | null }
        >('SELECT MAX(version) AS v FROM plan_versions WHERE job_id = ?')
        .get(input.jobId)?.v ?? 0) + 1;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO plan_versions (job_id, version, status, kind, author, parent_version, plan_json, checks_json, uses_json, proposed_at)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.jobId,
        next,
        input.kind,
        input.author,
        input.parentVersion,
        JSON.stringify(input.plan),
        JSON.stringify(input.checks),
        JSON.stringify(input.uses ?? []),
        this.now()
      );
    const version = this.version(Number(lastInsertRowid));
    if (!version) throw new Error('plan version vanished on insert');
    return version;
  }

  version(id: number): PlanVersionRecord | null {
    const row = this.db
      .prepare<[number], VersionRow>('SELECT * FROM plan_versions WHERE id = ?')
      .get(id);
    return row ? toVersion(row) : null;
  }

  versions(jobId: number): PlanVersionRecord[] {
    return this.db
      .prepare<
        [number],
        VersionRow
      >('SELECT * FROM plan_versions WHERE job_id = ? ORDER BY version')
      .all(jobId)
      .map(toVersion);
  }

  /** The newest version of a job's plan, whatever its status. */
  newest(jobId: number): PlanVersionRecord | null {
    return this.newestWith(jobId, null);
  }

  /** The version in force, or null before the first approval. */
  approved(jobId: number): PlanVersionRecord | null {
    return this.newestWith(jobId, 'approved');
  }

  /** A version waiting on the client, or null when none is. */
  pending(jobId: number): PlanVersionRecord | null {
    return this.newestWith(jobId, 'proposed');
  }

  private newestWith(jobId: number, status: PlanVersionStatus | null): PlanVersionRecord | null {
    const row = this.db
      .prepare<
        [number, string | null, string | null],
        VersionRow
      >('SELECT * FROM plan_versions WHERE job_id = ? AND (? IS NULL OR status = ?) ORDER BY version DESC LIMIT 1')
      .get(jobId, status, status);
    return row ? toVersion(row) : null;
  }

  /** Mark every version still waiting as replaced, before a newer one goes up or the job closes. */
  replacePending(jobId: number): void {
    this.db
      .prepare(
        `UPDATE plan_versions SET status = 'replaced', decided_at = ? WHERE job_id = ? AND status = 'proposed'`
      )
      .run(this.now(), jobId);
  }

  decide(id: number, status: PlanVersionStatus, note: string | null = null): void {
    this.db
      .prepare(
        'UPDATE plan_versions SET status = ?, decision_note = ?, decided_at = ? WHERE id = ?'
      )
      .run(status, note, this.now(), id);
  }

  /** Fleet approved the version on its own, under the project's trust level and its dollar limit. */
  markAutoStarted(id: number, usd: number): void {
    this.db.prepare('UPDATE plan_versions SET auto_start_usd = ? WHERE id = ?').run(usd, id);
  }

  /** The previous approved version steps down when a change is approved. */
  supersede(jobId: number): void {
    this.db
      .prepare(
        `UPDATE plan_versions SET status = 'superseded' WHERE job_id = ? AND status = 'approved'`
      )
      .run(jobId);
  }

  /** Write one JSON column of a plan version. */
  private setJson(
    id: number,
    column: 'bases_json' | 'snapshot_json' | 'checks_json' | 'effects_json',
    value: unknown
  ): void {
    this.db
      .prepare(`UPDATE plan_versions SET ${column} = ? WHERE id = ?`)
      .run(JSON.stringify(value), id);
  }

  setBases(id: number, bases: PlanBases): void {
    this.setJson(id, 'bases_json', bases);
  }

  setCrew(id: number, crew: CrewSnapshot): void {
    this.setJson(id, 'snapshot_json', crew);
  }

  setChecks(id: number, checks: PlanChecks): void {
    this.setJson(id, 'checks_json', checks);
  }

  setEffects(id: number, effects: AppliedEffects): void {
    this.setJson(id, 'effects_json', effects);
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  /** A job's steps in plan order, removed ones after the rest. */
  steps(jobId: number): AgencyStep[] {
    return this.db
      .prepare<
        [number],
        StepRow
      >(`SELECT * FROM job_steps WHERE job_id = ? ORDER BY (status = 'removed'), position`)
      .all(jobId)
      .map(toStep);
  }

  step(jobId: number, stepId: string): AgencyStep | null {
    const row = this.db
      .prepare<
        [number, string],
        StepRow
      >('SELECT * FROM job_steps WHERE job_id = ? AND step_id = ?')
      .get(jobId, stepId);
    return row ? toStep(row) : null;
  }

  /**
   * The step's next branch number, counted up for good: a job never uses the
   * same crew branch name twice.
   */
  nextBranchSeq(jobId: number, stepId: string): number {
    const row = this.db
      .prepare<[number, number, string], { branch_seq: number }>(
        `UPDATE job_steps SET branch_seq = branch_seq + 1, updated_at = ?
         WHERE job_id = ? AND step_id = ? RETURNING branch_seq`
      )
      .get(this.now(), jobId, stepId);
    if (!row) throw new Error(`${stepId} is not a step of j${jobId}.`);
    return row.branch_seq;
  }

  /** Add a step, or bring a removed one back, at `position`. */
  putStep(input: {
    jobId: number;
    stepId: string;
    role: string;
    position: number;
    version: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_steps (job_id, step_id, role, position, status, added_in, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(job_id, step_id) DO UPDATE SET role = excluded.role, position = excluded.position,
           status = CASE WHEN job_steps.status = 'removed' THEN 'pending' ELSE job_steps.status END,
           removed_in = NULL, updated_at = excluded.updated_at`
      )
      .run(input.jobId, input.stepId, input.role, input.position, input.version, this.now());
  }

  /** Steps waiting for a place to start, across every job, longest waiting first. */
  queuedSteps(): Array<{ jobId: number; stepId: string }> {
    return this.db
      .prepare<[], { job_id: number; step_id: string }>(
        `SELECT job_id, step_id FROM job_steps WHERE status = 'queued' ORDER BY updated_at, job_id`
      )
      .all()
      .map((r) => ({ jobId: r.job_id, stepId: r.step_id }));
  }

  setStepStatus(jobId: number, stepId: string, status: StepStatus, version?: number): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE job_steps SET status = ?, updated_at = ?,
           finished_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END,
           removed_in = CASE WHEN ? = 'removed' THEN ? ELSE removed_in END
         WHERE job_id = ? AND step_id = ?`
      )
      .run(status, at, status, at, status, version ?? null, jobId, stepId);
  }

  setStepNote(jobId: number, stepId: string, note: string): void {
    this.db
      .prepare('UPDATE job_steps SET note = ?, updated_at = ? WHERE job_id = ? AND step_id = ?')
      .run(note, this.now(), jobId, stepId);
  }

  // ── Record ───────────────────────────────────────────────────────────────

  log(input: {
    jobId: number;
    kind: string;
    text: string;
    stepId?: string | null;
    data?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        'INSERT INTO job_log (job_id, at, kind, step_id, text, data_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        input.jobId,
        this.now(),
        input.kind,
        input.stepId ?? null,
        input.text,
        JSON.stringify(input.data ?? {})
      );
  }

  /** Each step's newest `perStep` crew reports, oldest first, however long the record is. */
  crewReports(jobId: number, perStep: number): Array<{ stepId: string; text: string }> {
    return this.db
      .prepare<[number, number], { step_id: string; text: string }>(
        `SELECT step_id, text FROM
           (SELECT id, step_id, text,
              ROW_NUMBER() OVER (PARTITION BY step_id ORDER BY id DESC) AS n
            FROM job_log WHERE job_id = ? AND kind = 'crew' AND step_id IS NOT NULL)
         WHERE n <= ? ORDER BY id`
      )
      .all(jobId, perStep)
      .map((r) => ({ stepId: r.step_id, text: r.text }));
  }

  /** The newest `limit` record lines, oldest first. */
  logTail(jobId: number, limit = 200): AgencyJobLogEntry[] {
    return this.db
      .prepare<
        [number, number],
        { id: number; at: number; kind: string; step_id: string | null; text: string }
      >(
        `SELECT id, at, kind, step_id, text FROM
           (SELECT * FROM job_log WHERE job_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id`
      )
      .all(jobId, limit)
      .map((r) => ({ id: r.id, at: r.at, kind: r.kind, stepId: r.step_id, text: r.text }));
  }

  /** Delivered results per step and kind, for "every listed deliverable is in". */
  resultsByStep(jobId: number): Array<{ stepId: string | null; kind: string; label: string }> {
    return this.db
      .prepare<[number], { step_id: string | null; kind: string; label: string }>(
        'SELECT step_id, kind, label FROM results WHERE job_id = ?'
      )
      .all(jobId)
      .map((r) => ({ stepId: r.step_id, kind: r.kind, label: r.label }));
  }
}
