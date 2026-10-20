import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { z } from 'zod';
import {
  ADMIRAL_QUESTION_KINDS,
  AGENCY_QUESTION_KINDS,
  DEFAULT_AGENCY_SETTINGS,
  RUNNING_JOB_STATES,
  TERMINAL_JOB_STATES,
  jobDisplayId,
  questionDisplayId,
  type AgencyAnswerRequest,
  type AgencyJob,
  type AgencyJobEvent,
  type AgencyOnboarding,
  type AgencyQuestion,
  type AgencyQuestionKind,
  type AgencyQuestionOption,
  type AgencyQuestionStatus,
  type AgencyRepoRef,
  type AgencySnapshot,
  type BudgetRaise,
  type ClientDecision,
  type ClientFileProposal,
  type JobHoldKind,
  type JobState,
  type WakeupPull
} from '../../../shared/agency';
import type { AgencyProjectSummary } from '../../../shared/agency-projects';
import type { Plan } from '../../../shared/agency-plan';
import { LessonAnswer, type CrewLesson } from '../../../shared/agency-lessons';
import { YOU_LAYER } from '../../../shared/agency-client-file';
import { meetLeft } from '../../../shared/agency-meet';
import { parseJsonAs } from '../../../shared/parse-json';
import { WAKEUP_GIVE_UP_ATTEMPTS, WAKEUP_STALE_CLAIM_MS, wakeupBackoffMs } from '../backoff';
import { chainExhausted } from '../jobs/chain';
import { reduceJob, type CloseTarget, type JobEvent, type Transition } from '../jobs/job-machine';
import { renderWakeupText, type WakeupItem } from '../wakeup-text';
import { openAgencyDb } from './agency-db';
import { clientDecisions, DECISIONS_MAX, startOfDay } from './client-decisions';
import { CrewStore } from './crew-store';
import { PermissionStore } from './permission-store';
import { ResourceStore } from './resource-store';
import { MergeStore, ResultStore } from './result-store';
import { PlanStore } from './plan-store';
import { ProjectRegistry } from './project-registry';
import { SettingChangeStore } from './setting-change-store';
import { PreferenceStore } from './preference-store';
import { SpendStore } from './spend-store';

type JobRow = {
  id: number;
  repo_id: string;
  title: string;
  brief: string;
  state: string;
  session_id: string;
  handoff_done: number;
  budget_usd: number | null;
  budget_week_pct: number | null;
  created_at: number;
  updated_at: number;
  approved_version: number | null;
  close_target: string | null;
  chain_count: number;
  linked_job_id: number | null;
};

type QuestionRow = {
  id: number;
  repo_id: string;
  job_id: number | null;
  plan_version: number | null;
  step: string | null;
  kind: string;
  question: string;
  context: string;
  options_json: string;
  recommended: number | null;
  dep_question: number | null;
  dep_option: number | null;
  status: string;
  answer_option: number | null;
  answer_text: string | null;
  late: number;
  created_at: number;
  answered_at: number | null;
  withdrawn_reason: string | null;
  data_json: string;
};

type WakeupRow = {
  id: number;
  repo_id: string;
  job_id: number | null;
  kind: string;
  question_id: number | null;
  payload_json: string;
  attempts: number;
};

type JobEventRow = {
  job_id: number;
  at: number;
  from_state: string | null;
  to_state: string;
  reason: string;
};

/** A repository and job a write touched, for the change event it raises. */
export type AgencyTouched = { repoId: string; jobId: number | null };

export type OpenJobInput = {
  repoId: string;
  title: string;
  brief: string;
  sessionId: string;
  budgetUsd?: number | null;
  /** The job whose findings this one follows up on. */
  linkedJobId?: number | null;
};

export type AskQuestionInput = {
  repoId: string;
  jobId: number | null;
  question: string;
  context?: string;
  options: AgencyQuestionOption[];
  recommended?: number | null;
  dependsOn?: { question: number; option: number } | null;
  planVersion?: number | null;
  step?: string | null;
  kind?: AgencyQuestionKind;
  /** What a `client_file` card proposes. */
  proposal?: ClientFileProposal;
  /** What a `budget` card raises, and to what. */
  raise?: BudgetRaise;
  /** What a `crew_lesson` card would change in a role. */
  lesson?: CrewLesson;
};

export type AnswerOutcome = {
  question: AgencyQuestion;
  /** Hidden questions the answer revealed, because they waited on this option. */
  revealed: number[];
  /** Questions the answer withdrew, because they waited on another option. */
  withdrew: number[];
};

/** The wakeups that carry the client's own answers and actions, which run over a budget too. */
const CLIENT_KINDS = "AND kind IN ('answer', 'client_action')";

export type EnqueueWakeupInput = {
  repoId: string;
  jobId: number | null;
  /**
   * `client_action` is the client deciding on a card (a plan, a setting): their words, unfenced.
   * `permission` is a crew member waiting on the Admiral to answer a permission request.
   */
  kind: 'answer' | 'event' | 'client_action' | 'permission';
  questionId?: number | null;
  payload?: Record<string, unknown>;
  /** Higher runs first. Permission requests outrank everything else. */
  priority?: number;
  /** Not due before this time; due at once when unset. */
  notBefore?: number;
};

export type ReleaseOutcome = {
  nextDueAt: number | null;
  gaveUp: boolean;
  touched: AgencyTouched[];
};

const JOB_STATES: readonly JobState[] = [
  'briefing',
  'planned',
  'running',
  'waiting',
  'delivered',
  'closing',
  'closed',
  'cancelled',
  'failed',
  'interrupted'
];
const QUESTION_STATUSES: readonly AgencyQuestionStatus[] = [
  'open',
  'hidden',
  'answered',
  'withdrawn'
];

const OptionsJson = z.array(z.object({ label: z.string(), detail: z.string().optional() }));
const EventPayload = z.object({ line: z.string(), body: z.string().nullable().optional() });
const AnswerPayload = z.object({ withdrew: z.array(z.number()) });
const ClientPayload = z.object({
  line: z.string(),
  note: z.string().nullable().optional(),
  detail: z.string().nullable().optional()
});
const QuestionData = z.object({
  proposal: z
    .object({
      add: z.array(z.object({ text: z.string(), replaces: z.string().nullable() })),
      remove: z.array(z.string()),
      // Cards from before Remember this? have neither.
      topic: z.string().nullable().default(null),
      layer: z.enum(['project', 'you']).default('project')
    })
    .optional(),
  raise: z
    .object({ target: z.enum(['usd', 'week_pct', 'cap']), to: z.number().positive() })
    .optional(),
  lesson: LessonAnswer.extend({
    jobId: z.number().int(),
    source: z.enum(['project', 'user', 'bundled'])
  }).optional()
});

const HOLD_KINDS: readonly JobHoldKind[] = ['model', 'chain_limit', 'budget', 'client'];
const CLOSE_TARGETS: readonly CloseTarget[] = ['closed', 'cancelled', 'failed'];

/** How many answered or withdrawn questions a snapshot carries besides the open ones. */
const SNAPSHOT_RECENT_QUESTIONS = 100;

/** How many ended jobs a snapshot lists for export. */
const SNAPSHOT_PAST_JOBS = 10;
/** Settings cards a snapshot carries, so a chat row can draw the card it put up. */
const SNAPSHOT_SETTINGS_CARDS = 30;

function jobState(raw: string): JobState {
  return JOB_STATES.find((s) => s === raw) ?? 'failed';
}

function questionStatus(raw: string): AgencyQuestionStatus {
  return QUESTION_STATUSES.find((s) => s === raw) ?? 'withdrawn';
}

function toJob(
  row: JobRow,
  holds: JobHoldKind[],
  pendingPlan: AgencyJob['pendingPlan'],
  crewNeedingYou: number,
  permissionsWaiting: number[]
): AgencyJob {
  return {
    id: row.id,
    repoId: row.repo_id,
    title: row.title,
    brief: row.brief,
    state: jobState(row.state),
    approvedVersion: row.approved_version,
    closeTarget: CLOSE_TARGETS.find((t) => t === row.close_target) ?? null,
    chainCount: row.chain_count,
    linkedJobId: row.linked_job_id,
    holds,
    pendingPlan,
    crewNeedingYou,
    permissionsWaiting,
    sessionId: row.session_id,
    handoffDone: row.handoff_done === 1,
    budgetUsd: row.budget_usd,
    budgetWeekPct: row.budget_week_pct,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toQuestion(row: QuestionRow): AgencyQuestion {
  return {
    id: row.id,
    repoId: row.repo_id,
    jobId: row.job_id,
    planVersion: row.plan_version,
    step: row.step,
    kind: AGENCY_QUESTION_KINDS.find((k) => k === row.kind) ?? 'ask',
    question: row.question,
    context: row.context,
    options: parseJsonAs(OptionsJson, row.options_json) ?? [],
    recommended: row.recommended,
    dependsOn:
      row.dep_question !== null && row.dep_option !== null
        ? { question: row.dep_question, option: row.dep_option }
        : null,
    status: questionStatus(row.status),
    answerOption: row.answer_option,
    answerText: row.answer_text,
    proposal:
      row.kind === 'client_file'
        ? (parseJsonAs(QuestionData, row.data_json)?.proposal ?? null)
        : null,
    raise: row.kind === 'budget' ? (parseJsonAs(QuestionData, row.data_json)?.raise ?? null) : null,
    lesson:
      row.kind === 'crew_lesson'
        ? (parseJsonAs(QuestionData, row.data_json)?.lesson ?? null)
        : null,
    late: row.late === 1,
    withdrawnReason: row.withdrawn_reason,
    createdAt: row.created_at,
    answeredAt: row.answered_at
  };
}

/**
 * Whether `req` is an answer `q` can take: the client has seen it (not hidden),
 * nobody answered it yet, and the answer names one of its options or says
 * something.
 */
function answerable(q: AgencyQuestion, req: AgencyAnswerRequest): boolean {
  if (q.status === 'hidden' || q.answeredAt !== null) return false;
  if (req.option !== undefined) return req.option >= 0 && req.option < q.options.length;
  return (req.text?.trim() ?? '') !== '';
}

/** `?, ?, ?` for an IN list of `n` values. */
function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function distinctTouched(rows: AgencyTouched[]): AgencyTouched[] {
  const seen = new Map<string, AgencyTouched>();
  for (const row of rows) seen.set(`${row.repoId}\u0000${row.jobId ?? ''}`, row);
  return [...seen.values()];
}

/**
 * The agency's durable state: jobs, the questions the Admiral asks the client,
 * and the wakeups that bring the Admiral back to a job.
 *
 * Wakeups are leased, not popped. A pull claims every due wakeup for one job
 * and hands them back as one text; the renderer acks them when the turn they
 * opened finishes, or releases them when it fails, which schedules a retry. A
 * claim that is never settled - the renderer went away mid-turn - goes stale
 * and is handed out again, so a wakeup is never lost to a crash.
 *
 * Everything is keyed by job, with NULL for the lobby, and a pull for one job
 * never touches another's rows: a job A wakeup cannot land in job B.
 */
export class AgencyStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  /** How many automatic Admiral turns a job takes in a row before it asks to continue. */
  private readonly turnLimit: () => number;
  readonly plans: PlanStore;
  readonly crew: CrewStore;
  readonly permissions: PermissionStore;
  readonly resources: ResourceStore;
  readonly results: ResultStore;
  readonly merges: MergeStore;
  readonly settings: SettingChangeStore;
  readonly projects: ProjectRegistry;
  readonly spend: SpendStore;
  readonly preferences: PreferenceStore;

  constructor(
    db: Database.Database | string,
    opts: { now?: () => number; turnLimit?: () => number } = {}
  ) {
    this.db = typeof db === 'string' ? openAgencyDb(db) : db;
    this.now = opts.now ?? Date.now;
    this.turnLimit = opts.turnLimit ?? (() => DEFAULT_AGENCY_SETTINGS.admiral.turnLimit);
    this.plans = new PlanStore(this.db, this.now);
    this.crew = new CrewStore(this.db, this.now);
    this.permissions = new PermissionStore(this.db, this.now);
    this.resources = new ResourceStore(this.db, this.now);
    this.results = new ResultStore(this.db, this.now);
    this.merges = new MergeStore(this.db, this.now);
    this.settings = new SettingChangeStore(this.db, this.now);
    this.projects = new ProjectRegistry(this.db, this.now);
    this.spend = new SpendStore(this.db, this.now);
    this.preferences = new PreferenceStore(this.db, this.now);
  }

  /**
   * Run `fn` in one transaction. Nested calls become savepoints, so a job
   * service can span the plan, crew and job tables and still commit once.
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  // ── Repositories and lobbies ─────────────────────────────────────────────

  /**
   * Record the repository and return its lobby session id, minting one the
   * first time. The root and name are refreshed each call, since a repository
   * can be moved or renamed while its identity stays.
   */
  ensureLobby(repo: AgencyRepoRef, mintSessionId: () => string = randomUUID): string {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO repos (repo_id, root, name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET root = excluded.root, name = excluded.name`
        )
        .run(repo.repoId, repo.root, repo.name, this.now());
      const existing = this.lobbySessionId(repo.repoId);
      if (existing !== null) return existing;
      const sessionId = mintSessionId();
      this.db
        .prepare('INSERT INTO lobbies (repo_id, session_id) VALUES (?, ?)')
        .run(repo.repoId, sessionId);
      return sessionId;
    })();
  }

  /** A job and the repository it is in, or null when either is not known. */
  jobRepo(jobId: number): { job: AgencyJob; repo: AgencyRepoRef } | null {
    const job = this.getJob(jobId);
    const repo = job === null ? null : this.repo(job.repoId);
    return job === null || repo === null ? null : { job, repo };
  }

  /** A repository `ensureLobby` has recorded, or null for one it never saw. */
  repo(repoId: string): AgencyRepoRef | null {
    const row = this.db
      .prepare<
        [string],
        { repo_id: string; root: string; name: string }
      >('SELECT repo_id, root, name FROM repos WHERE repo_id = ?')
      .get(repoId);
    return row ? { repoId: row.repo_id, root: row.root, name: row.name } : null;
  }

  /** Whether an agent session is an Admiral lobby's or a job's. */
  isAdmiralSession(sessionId: string): boolean {
    return (
      this.db
        .prepare<[string, string], { found: number }>(
          `SELECT 1 AS found FROM lobbies WHERE session_id = ?
           UNION ALL SELECT 1 FROM jobs WHERE session_id = ? LIMIT 1`
        )
        .get(sessionId, sessionId) !== undefined
    );
  }

  lobbySessionId(repoId: string): string | null {
    return this.lobby(repoId)?.session_id ?? null;
  }

  /** The last lobby message already carried into a job, or null before the first handoff. */
  lastHandoffMessageId(repoId: string): string | null {
    return this.lobby(repoId)?.last_handoff_message_id ?? null;
  }

  private lobby(
    repoId: string
  ): { session_id: string; last_handoff_message_id: string | null } | undefined {
    return this.db
      .prepare<
        [string],
        { session_id: string; last_handoff_message_id: string | null }
      >('SELECT session_id, last_handoff_message_id FROM lobbies WHERE repo_id = ?')
      .get(repoId);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────

  openJob(input: OpenJobInput): AgencyJob {
    return this.db.transaction(() => {
      const at = this.now();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO jobs (repo_id, title, brief, state, session_id, budget_usd, linked_job_id, created_at, updated_at)
           VALUES (?, ?, ?, 'briefing', ?, ?, ?, ?, ?)`
        )
        .run(
          input.repoId,
          input.title,
          input.brief,
          input.sessionId,
          input.budgetUsd ?? null,
          input.linkedJobId ?? null,
          at,
          at
        );
      const id = Number(lastInsertRowid);
      this.recordJobEvent(id, null, 'briefing', 'opened', at);
      const job = this.getJob(id);
      if (!job) throw new Error(`job ${id} vanished on insert`);
      return job;
    })();
  }

  getJob(id: number): AgencyJob | null {
    const row = this.db.prepare<[number], JobRow>('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? this.toJob(row) : null;
  }

  private toJob(row: JobRow): AgencyJob {
    const pending = this.plans.pending(row.id);
    return toJob(
      row,
      this.holds(row.id),
      pending ? { id: pending.id, version: pending.version } : null,
      this.crew.needingYou(row.id),
      this.permissions.waitingOnClient(row.id)
    );
  }

  /** Put an approved plan version in force, with the budgets it set. */
  setApprovedVersion(jobId: number, version: number, budget: Plan['budget']): void {
    this.db
      .prepare(
        'UPDATE jobs SET approved_version = ?, budget_usd = ?, budget_week_pct = ?, updated_at = ? WHERE id = ?'
      )
      .run(version, budget.usd, budget.weekPct ?? null, this.now(), jobId);
  }

  /** A repository's jobs, oldest first; closed, cancelled and failed ones only when asked. */
  listJobs(repoId: string, opts: { includeTerminal?: boolean } = {}): AgencyJob[] {
    const rows = opts.includeTerminal
      ? this.db
          .prepare<[string], JobRow>('SELECT * FROM jobs WHERE repo_id = ? ORDER BY id')
          .all(repoId)
      : this.db
          .prepare<
            unknown[],
            JobRow
          >(`SELECT * FROM jobs WHERE repo_id = ? AND state NOT IN (${marks(TERMINAL_JOB_STATES.length)}) ORDER BY id`)
          .all(repoId, ...TERMINAL_JOB_STATES);
    return rows.map((row) => this.toJob(row));
  }

  /** Jobs in every repository with work under way, for the quit guard. */
  listRunning(): AgencyJob[] {
    return this.jobsIn(RUNNING_JOB_STATES);
  }

  /** Jobs in every repository in one of `states`, oldest first. */
  jobsIn(states: readonly JobState[]): AgencyJob[] {
    return this.db
      .prepare<unknown[], JobRow>(
        `SELECT * FROM jobs WHERE state IN (${marks(states.length)}) ORDER BY id`
      )
      .all(...states)
      .map((row) => this.toJob(row));
  }

  /**
   * Run `event` through the job state machine and write the move with when
   * and why. A refused event writes nothing; a move to the same state writes
   * no event row. A job that starts running while something holds it goes
   * straight on to `waiting`.
   */
  applyJobEvent(
    id: number,
    event: JobEvent,
    reason: string
  ): { job: AgencyJob | null; transition: Transition } {
    return this.db.transaction((): { job: AgencyJob | null; transition: Transition } => {
      const job = this.getJob(id);
      if (!job) return { job: null, transition: { ok: false, refused: `there is no job ${id}` } };
      const transition = reduceJob(job.state, event);
      if (!transition.ok || !transition.changed) return { job, transition };
      const at = this.now();
      this.db
        .prepare(
          'UPDATE jobs SET state = ?, updated_at = ?, close_target = COALESCE(?, close_target) WHERE id = ?'
        )
        .run(transition.to, at, transition.closeTarget ?? null, id);
      this.recordJobEvent(id, job.state, transition.to, reason, at);
      if (transition.to === 'running') this.syncWaiting(id);
      return { job: this.getJob(id), transition };
    })();
  }

  /**
   * Start closing a job: move it to `closing` (remembering how it ends),
   * withdraw its open questions, drop its pending wakeups and holds. Cleanup
   * then runs, and `finishClose` ends the job. A second close joins the
   * first, keeping the end the first one asked for.
   */
  beginClose(
    id: number,
    event: Extract<JobEvent, { type: 'cancel' | 'accepted' | 'fail' }>,
    reason: string
  ): { job: AgencyJob | null; transition: Transition } {
    return this.db.transaction(() => {
      const result = this.applyJobEvent(id, event, reason);
      if (!result.transition.ok || !result.transition.changed) return result;
      this.db
        .prepare(
          `UPDATE questions SET status = 'withdrawn', withdrawn_reason = ?
           WHERE job_id = ? AND status IN ('open', 'hidden')`
        )
        .run('the job is closing', id);
      this.db
        .prepare('UPDATE wakeups SET done_at = ? WHERE job_id = ? AND done_at IS NULL')
        .run(this.now(), id);
      this.db.prepare('DELETE FROM job_holds WHERE job_id = ?').run(id);
      this.plans.replacePending(id);
      return { ...result, job: this.getJob(id) };
    })();
  }

  /**
   * Withdraw the questions still open on jobs that have ended. Closing
   * withdraws a job's questions, so these were asked after: nothing would
   * ever take them off the client's list.
   */
  withdrawEndedJobQuestions(): AgencyTouched[] {
    return this.db
      .prepare<[string], { repo_id: string; job_id: number }>(
        `UPDATE questions SET status = 'withdrawn', withdrawn_reason = ?
         WHERE status IN ('open', 'hidden')
           AND job_id IN (SELECT id FROM jobs WHERE state IN ('closed', 'cancelled', 'failed'))
         RETURNING repo_id, job_id`
      )
      .all('the job had ended')
      .map((row) => ({ repoId: row.repo_id, jobId: row.job_id }));
  }

  /** End a closing job the way its close asked for, once cleanup is done. */
  finishClose(id: number, reason: string): AgencyJob | null {
    const job = this.getJob(id);
    if (job?.state !== 'closing') return job;
    return this.applyJobEvent(
      id,
      { type: 'cleanup_done', target: job.closeTarget ?? 'cancelled' },
      reason
    ).job;
  }

  // ── Holds ────────────────────────────────────────────────────────────────

  holds(jobId: number): JobHoldKind[] {
    const kinds = new Set(
      this.db
        .prepare<[number], { kind: string }>('SELECT kind FROM job_holds WHERE job_id = ?')
        .all(jobId)
        .map((row) => row.kind)
    );
    return HOLD_KINDS.filter((k) => kinds.has(k));
  }

  /** What a hold on a job says, such as when it lifts; null when the job is not held so. */
  holdDetail(jobId: number, kind: JobHoldKind): string | null {
    return (
      this.db
        .prepare<
          [number, string],
          { detail: string }
        >('SELECT detail FROM job_holds WHERE job_id = ? AND kind = ?')
        .get(jobId, kind)?.detail ?? null
    );
  }

  /** Hold a job, so a running one waits until every hold is released. */
  addHold(jobId: number, kind: JobHoldKind, detail = ''): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO job_holds (job_id, kind, since, detail) VALUES (?, ?, ?, ?)
           ON CONFLICT(job_id, kind) DO UPDATE SET detail = excluded.detail`
        )
        .run(jobId, kind, this.now(), detail);
      this.syncWaiting(jobId);
    })();
  }

  releaseHold(jobId: number, kind: JobHoldKind): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM job_holds WHERE job_id = ? AND kind = ?').run(jobId, kind);
      this.syncWaiting(jobId);
    })();
  }

  /**
   * Make the job's state agree with its holds: a held running job waits, and
   * a waiting job with nothing left holding it runs. Other states keep their
   * state; the hold stays recorded and applies once the job runs.
   */
  private syncWaiting(jobId: number): void {
    const job = this.getJob(jobId);
    if (!job) return;
    if (job.state === 'running' && job.holds.length > 0) {
      this.applyJobEvent(jobId, { type: 'blocked' }, `waiting on ${job.holds.join(', ')}`);
    } else if (job.state === 'waiting' && job.holds.length === 0) {
      this.applyJobEvent(jobId, { type: 'unblocked' }, 'nothing holds it any more');
    }
  }

  // ── Automatic turns ──────────────────────────────────────────────────────

  /**
   * The client did something for this job (sent a message, answered, decided
   * a plan) or a step finished: start counting automatic turns from zero, and
   * take down a "continue?" card that is up.
   */
  resetChain(jobId: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE jobs SET chain_count = 0 WHERE id = ?').run(jobId);
      for (const q of this.listOpenFleetCards(jobId, 'continue')) {
        this.withdrawCascade(q.id, 'the client went on');
      }
      this.releaseHold(jobId, 'chain_limit');
    })();
  }

  /**
   * Count one automatic turn for a job with an approved plan. At the limit the
   * turn does not run: the job waits behind a "continue?" card instead.
   * Returns whether the turn may run.
   */
  private countAutomaticTurn(job: AgencyJob): boolean {
    if (job.approvedVersion === null) return true;
    const limit = this.turnLimit();
    if (!chainExhausted(job.chainCount, limit)) {
      this.db.prepare('UPDATE jobs SET chain_count = chain_count + 1 WHERE id = ?').run(job.id);
      return true;
    }
    if (this.listOpenFleetCards(job.id, 'continue').length === 0) {
      this.askQuestion({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'continue',
        question: `The Admiral took ${limit} turns in a row on its own`,
        context: 'The job waits so it does not run away. Continue to let it go on.',
        options: [
          { label: 'Continue', detail: `${limit} more turns` },
          { label: 'Not now', detail: 'the job waits; send a message to go on' }
        ],
        recommended: 0
      });
    }
    this.addHold(job.id, 'chain_limit');
    return false;
  }

  /** A job's open cards of one kind that Fleet itself put up. */
  openFleetCards(jobId: number, kind: AgencyQuestionKind): AgencyQuestion[] {
    return this.listOpenFleetCards(jobId, kind);
  }

  /** Take down a job's open cards of one kind, and what waits on them. */
  withdrawFleetCards(jobId: number, kind: AgencyQuestionKind, reason: string): void {
    this.db.transaction(() => {
      for (const q of this.listOpenFleetCards(jobId, kind)) this.withdrawCascade(q.id, reason);
    })();
  }

  private listOpenFleetCards(jobId: number, kind: AgencyQuestionKind): AgencyQuestion[] {
    return this.db
      .prepare<
        [number, string],
        QuestionRow
      >(`SELECT * FROM questions WHERE job_id = ? AND kind = ? AND status = 'open' ORDER BY id`)
      .all(jobId, kind)
      .map(toQuestion);
  }

  jobEvents(jobId: number): AgencyJobEvent[] {
    return this.db
      .prepare<[number], JobEventRow>(
        'SELECT job_id, at, from_state, to_state, reason FROM job_events WHERE job_id = ? ORDER BY id'
      )
      .all(jobId)
      .map((row) => ({
        jobId: row.job_id,
        at: row.at,
        from: row.from_state === null ? null : jobState(row.from_state),
        to: jobState(row.to_state),
        reason: row.reason
      }));
  }

  /**
   * Start cancelling a repository's running jobs, as closing its Admiral with
   * "Cancel jobs" asks. Returns the ids of the jobs now closing.
   */
  cancelJobs(repoId: string, reason = 'cancelled by the client'): number[] {
    return this.db.transaction(() =>
      this.listJobs(repoId)
        .filter((job) => RUNNING_JOB_STATES.includes(job.state))
        .filter((job) => this.beginClose(job.id, { type: 'cancel' }, reason).transition.ok)
        .map((job) => job.id)
    )();
  }

  /**
   * Note that the lobby messages up to `lobbyMessageId` were carried into
   * `jobId`. Idempotent: the renderer reconciles on attach and may call it for
   * a handoff that already went through.
   */
  /**
   * The lobby talk that led to a job is in its conversation now. The first
   * time, the job's Admiral wakes to plan from it: nothing else would start a
   * turn there before the client writes.
   */
  markHandoff(input: { jobId: number; lobbyMessageId: string }): AgencyJob | null {
    return this.db.transaction(() => {
      const job = this.getJob(input.jobId);
      if (!job) return null;
      this.db
        .prepare('UPDATE jobs SET handoff_done = 1, updated_at = ? WHERE id = ?')
        .run(this.now(), job.id);
      this.db
        .prepare('UPDATE lobbies SET last_handoff_message_id = ? WHERE repo_id = ?')
        .run(input.lobbyMessageId, job.repoId);
      if (!job.handoffDone) {
        this.enqueueWakeup({
          repoId: job.repoId,
          jobId: job.id,
          kind: 'event',
          payload: {
            line: 'Job opened from the Bridge',
            body: [
              'The talk that led to it is above. Propose the plan with job_plan, or ask the client what is still missing.',
              ...(job.linkedJobId === null
                ? []
                : [
                    `It follows ${jobDisplayId(job.linkedJobId)}: read what that job found with job_results.`
                  ])
            ].join(' ')
          }
        });
      }
      return this.getJob(job.id);
    })();
  }

  private recordJobEvent(
    jobId: number,
    from: JobState | null,
    to: JobState,
    reason: string,
    at: number
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_events (job_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)'
      )
      .run(jobId, at, from, to, reason);
  }

  // ── Questions ────────────────────────────────────────────────────────────

  /**
   * Put a question to the client. A question that depends on another one's
   * answer starts hidden, or settles at once if that answer is already in.
   */
  askQuestion(input: AskQuestionInput): AgencyQuestion {
    const kind = input.kind ?? 'ask';
    if (kind === 'ask' && (input.options.length < 2 || input.options.length > 4)) {
      throw new Error('A question needs two to four options');
    }
    const recommended = input.recommended ?? null;
    if (recommended !== null && (recommended < 0 || recommended >= input.options.length)) {
      throw new Error(`The recommended option ${recommended + 1} is not one of the options`);
    }
    return this.db.transaction(() => {
      const dep = input.dependsOn ?? null;
      let status: AgencyQuestionStatus = 'open';
      let withdrawnReason: string | null = null;
      if (dep !== null) {
        const parent = this.getQuestion(dep.question);
        if (parent?.repoId !== input.repoId || parent.jobId !== input.jobId) {
          throw new Error(`${questionDisplayId(dep.question)} is not a question in this job`);
        }
        if (dep.option < 0 || dep.option >= parent.options.length) {
          throw new Error(
            `${questionDisplayId(dep.question)} has no option ${dep.option + 1} to depend on`
          );
        }
        const settled = this.dependentStatus(parent, dep.option);
        status = settled.status;
        withdrawnReason = settled.reason;
      }
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO questions (repo_id, job_id, plan_version, step, kind, question, context,
             options_json, recommended, dep_question, dep_option, status, withdrawn_reason, created_at,
             data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.repoId,
          input.jobId,
          input.planVersion ?? null,
          input.step ?? null,
          kind,
          input.question,
          input.context ?? '',
          JSON.stringify(input.options),
          recommended,
          dep?.question ?? null,
          dep?.option ?? null,
          status,
          withdrawnReason,
          this.now(),
          JSON.stringify({
            ...(input.proposal !== undefined && { proposal: input.proposal }),
            ...(input.raise !== undefined && { raise: input.raise }),
            ...(input.lesson !== undefined && { lesson: input.lesson })
          })
        );
      const question = this.getQuestion(Number(lastInsertRowid));
      if (!question) throw new Error('question vanished on insert');
      return question;
    })();
  }

  /** Where a question depending on `parent` answering `option` stands right now. */
  private dependentStatus(
    parent: AgencyQuestion,
    option: number
  ): { status: AgencyQuestionStatus; reason: string | null } {
    const id = questionDisplayId(parent.id);
    if (parent.status === 'withdrawn') {
      return { status: 'withdrawn', reason: `${id} was withdrawn` };
    }
    if (parent.status !== 'answered') return { status: 'hidden', reason: null };
    return parent.answerOption === option
      ? { status: 'open', reason: null }
      : { status: 'withdrawn', reason: `${id} was answered with another option` };
  }

  getQuestion(id: number): AgencyQuestion | null {
    const row = this.db
      .prepare<[number], QuestionRow>('SELECT * FROM questions WHERE id = ?')
      .get(id);
    return row ? toQuestion(row) : null;
  }

  /** A repository's questions, oldest first, narrowed to one job (null: lobby) or statuses. */
  listQuestions(
    repoId: string,
    opts: { jobId?: number | null; statuses?: readonly AgencyQuestionStatus[] } = {}
  ): AgencyQuestion[] {
    const where = ['repo_id = ?'];
    const args: Array<string | number | null> = [repoId];
    if (opts.jobId !== undefined) {
      where.push('job_id IS ?');
      args.push(opts.jobId);
    }
    if (opts.statuses) {
      where.push(`status IN (${marks(opts.statuses.length)})`);
      args.push(...opts.statuses);
    }
    return this.db
      .prepare<unknown[], QuestionRow>(
        `SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY id`
      )
      .all(...args)
      .map(toQuestion);
  }

  /**
   * Record the client's answer and queue the wakeup that tells the Admiral.
   *
   * An answer to a withdrawn question is kept, marked late, and still
   * delivered: the client said something, and the Admiral should know even if
   * it no longer asks. A hidden question cannot be answered (the client never
   * saw it), and none can be answered twice. Questions waiting on this
   * one are revealed or withdrawn by the option picked.
   *
   * A model-unreachable notice is the client's own control, not something the
   * Admiral asked: answering it wakes nobody, and its first option retries.
   */
  answerQuestion(req: AgencyAnswerRequest): AnswerOutcome | null {
    return this.db.transaction(() => {
      const q = this.getQuestion(req.id);
      if (!q || !answerable(q, req)) return null;
      const option = req.option ?? null;
      const text = req.text?.trim() ?? '';

      const late = q.status === 'withdrawn';
      const at = this.now();
      this.db
        .prepare(
          `UPDATE questions SET status = ?, answer_option = ?, answer_text = ?, late = ?, answered_at = ?
           WHERE id = ?`
        )
        .run(
          late ? 'withdrawn' : 'answered',
          option,
          text === '' ? null : text,
          late ? 1 : 0,
          at,
          q.id
        );

      if (!ADMIRAL_QUESTION_KINDS.includes(q.kind)) {
        this.answerFleetCard(q, option);
        const answered = this.getQuestion(q.id);
        return answered ? { question: answered, revealed: [], withdrew: [] } : null;
      }
      if (q.jobId !== null) this.resetChain(q.jobId);

      const { revealed, withdrew } = late
        ? { revealed: [], withdrew: [] }
        : this.settleDependents(q.id, option);
      this.enqueueWakeup({
        repoId: q.repoId,
        jobId: q.jobId,
        kind: 'answer',
        questionId: q.id,
        payload: { withdrew }
      });
      const answered = this.getQuestion(q.id);
      return answered ? { question: answered, revealed, withdrew } : null;
    })();
  }

  /** Act on the client's pick on one of Fleet's own cards. */
  private answerFleetCard(q: AgencyQuestion, option: number | null): void {
    if (q.kind === 'model_unreachable' && option === 0) this.retryNow(q.repoId);
    if (q.kind === 'continue' && option === 0 && q.jobId !== null) this.resetChain(q.jobId);
    if (q.kind === 'resume' && option === 0 && q.jobId !== null) this.resumeJob(q.jobId);
    if (q.kind === 'rehire') this.answerRehire(q, option === 0);
  }

  /**
   * The client's pick on a `rehire` card, put up when a step's crew member
   * left before the step was done: the step may be hired for again, or it
   * stays stopped. Either way the Admiral hears of it.
   */
  private answerRehire(q: AgencyQuestion, again: boolean): void {
    const { jobId, step: stepId } = q;
    if (jobId === null || stepId === null) return;
    const status = this.plans.step(jobId, stepId)?.status;
    const reopens = again && (status === 'stopped' || status === 'failed');
    if (reopens) {
      this.plans.setStepStatus(jobId, stepId, 'pending');
      this.plans.log({ jobId, kind: 'step', stepId, text: `Step ${stepId} may be hired again` });
    }
    this.resetChain(jobId);
    this.enqueueWakeup({
      repoId: q.repoId,
      jobId,
      kind: 'event',
      payload: reopens
        ? {
            line: `The client lets step ${stepId} be hired again`,
            body: 'Hire for it with crew_hire, with a brief that says what the last crew member left in its worktree.'
          }
        : {
            line: `The client leaves step ${stepId} as it is`,
            body: 'Ask the client what they want instead, or propose a plan change.'
          }
    });
  }

  /** The client picked Resume after a restart: the job runs again, and the Admiral restarts its steps. */
  private resumeJob(jobId: number): void {
    const { job, transition } = this.applyJobEvent(
      jobId,
      { type: 'resume' },
      'the client picked Resume'
    );
    if (!job || !transition.ok || !transition.changed) return;
    this.resetChain(jobId);
    this.enqueueWakeup({
      repoId: job.repoId,
      jobId,
      kind: 'event',
      payload: {
        line: 'The client picked Resume',
        body: 'Hire for each interrupted step again with crew_hire: Fleet resumes its crew member where it was, in the same worktree and conversation.'
      }
    });
  }

  /** Reveal the hidden questions waiting on `option`, and withdraw the rest. */
  private settleDependents(
    parentId: number,
    option: number | null
  ): { revealed: number[]; withdrew: number[] } {
    const waiting = this.db
      .prepare<
        [number],
        { id: number; dep_option: number }
      >(`SELECT id, dep_option FROM questions WHERE dep_question = ? AND status = 'hidden'`)
      .all(parentId);
    const revealed: number[] = [];
    const withdrew: number[] = [];
    for (const row of waiting) {
      if (row.dep_option === option) {
        this.db.prepare(`UPDATE questions SET status = 'open' WHERE id = ?`).run(row.id);
        revealed.push(row.id);
      } else {
        withdrew.push(
          ...this.withdrawCascade(
            row.id,
            `${questionDisplayId(parentId)} was answered with another option`
          )
        );
      }
    }
    return { revealed, withdrew };
  }

  /** Withdraw a question and every open or hidden question waiting on it. */
  private withdrawCascade(id: number, reason: string): number[] {
    const changed = this.db
      .prepare(
        `UPDATE questions SET status = 'withdrawn', withdrawn_reason = ?
         WHERE id = ? AND status IN ('open', 'hidden')`
      )
      .run(reason, id).changes;
    if (changed === 0) return [];
    const children = this.db
      .prepare<
        [number],
        { id: number }
      >(`SELECT id FROM questions WHERE dep_question = ? AND status IN ('open', 'hidden')`)
      .all(id);
    return [
      id,
      ...children.flatMap((c) =>
        this.withdrawCascade(c.id, `${questionDisplayId(id)} was withdrawn`)
      )
    ];
  }

  /**
   * Take a question back, with the questions that depended on it. Answered or
   * already withdrawn questions are left as they are. Returns the question as
   * it now stands, or null when there is no such question.
   */
  withdrawQuestion(id: number, reason: string): AgencyQuestion | null {
    return this.db.transaction(() => {
      this.withdrawCascade(id, reason);
      return this.getQuestion(id);
    })();
  }

  /** Withdraw every open or hidden question tied to one plan step. Returns their ids. */
  withdrawForStep(input: { jobId: number; step: string; reason: string }): number[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<
          [number, string],
          { id: number }
        >(`SELECT id FROM questions WHERE job_id = ? AND step = ? AND status IN ('open', 'hidden') ORDER BY id`)
        .all(input.jobId, input.step);
      return [...new Set(rows.flatMap((row) => this.withdrawCascade(row.id, input.reason)))];
    })();
  }

  // ── Wakeups ──────────────────────────────────────────────────────────────

  enqueueWakeup(input: EnqueueWakeupInput): number {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO wakeups (repo_id, job_id, kind, question_id, payload_json, priority, not_before, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.repoId,
        input.jobId,
        input.kind,
        input.questionId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.priority ?? 1,
        input.notBefore ?? 0,
        this.now()
      );
    return Number(lastInsertRowid);
  }

  /**
   * Claim every wakeup due for one job (null: the lobby) and render them as
   * the text of one turn. Claims gone stale for that job are released first,
   * so a turn lost to a reload does not hold its wakeups forever.
   * `clientOnly` claims only the client's own answers and actions, for a job
   * over its budget.
   */
  pullWakeups(input: { repoId: string; jobId: number | null }, clientOnly = false): WakeupPull {
    return this.db.transaction(() => {
      this.releaseStaleClaims(WAKEUP_STALE_CLAIM_MS, input);
      const now = this.now();
      const rows = this.db
        .prepare<[string, number | null, number], WakeupRow>(
          `SELECT id, repo_id, job_id, kind, question_id, payload_json, attempts FROM wakeups
           WHERE repo_id = ? AND job_id IS ? AND done_at IS NULL AND claimed_at IS NULL AND not_before <= ?
           ${clientOnly ? CLIENT_KINDS : ''} ORDER BY priority DESC, id`
        )
        .all(input.repoId, input.jobId, now);
      const job = input.jobId === null ? null : this.getJob(input.jobId);
      // A crew member waiting on a permission answer is crew work, not the
      // Admiral running on its own: it neither counts as an automatic turn nor
      // waits behind the limit, while everything else does.
      const limited =
        job !== null &&
        rows.some((r) => r.kind !== 'permission') &&
        (job.holds.includes('chain_limit') || !this.countAutomaticTurn(job));
      const due = limited ? rows.filter((r) => r.kind === 'permission') : rows;
      if (limited && due.length === 0) return { ids: [], text: null, nextDueAt: null };
      if (due.length > 0) {
        this.db
          .prepare(`UPDATE wakeups SET claimed_at = ? WHERE id IN (${marks(due.length)})`)
          .run(now, ...due.map((r) => r.id));
      }
      return {
        ids: due.map((r) => r.id),
        text: renderWakeupText(due.flatMap((r) => this.wakeupItem(r))),
        nextDueAt: limited ? null : this.nextDueAt(input.repoId, input.jobId, clientOnly)
      };
    })();
  }

  private wakeupItem(row: WakeupRow): WakeupItem[] {
    if (row.kind === 'answer' && row.question_id !== null) {
      const question = this.getQuestion(row.question_id);
      if (!question) return [];
      const withdrew = parseJsonAs(AnswerPayload, row.payload_json)?.withdrew ?? [];
      return [{ kind: 'answer', question, withdrew }];
    }
    if (row.kind === 'client_action') {
      const action = parseJsonAs(ClientPayload, row.payload_json);
      return action
        ? [
            {
              kind: 'client',
              line: action.line,
              note: action.note ?? null,
              detail: action.detail ?? null
            }
          ]
        : [];
    }
    const event = parseJsonAs(EventPayload, row.payload_json);
    return event ? [{ kind: 'event', line: event.line, body: event.body ?? null }] : [];
  }

  /** When the next unclaimed wakeup for a job becomes due, or null when none waits. */
  private nextDueAt(repoId: string, jobId: number | null, clientOnly = false): number | null {
    const row = this.db
      .prepare<[string, number | null], { due: number | null }>(
        `SELECT MIN(not_before) AS due FROM wakeups
         WHERE repo_id = ? AND job_id IS ? AND done_at IS NULL AND claimed_at IS NULL
         ${clientOnly ? CLIENT_KINDS : ''}`
      )
      .get(repoId, jobId);
    return row?.due ?? null;
  }

  /**
   * Settle wakeups whose turn went through. A model-error notice still up for
   * those jobs is withdrawn, and a job it put on hold goes back to where it was.
   */
  ackWakeups(ids: number[]): AgencyTouched[] {
    if (ids.length === 0) return [];
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<
          unknown[],
          { repo_id: string; job_id: number | null }
        >(`SELECT DISTINCT repo_id, job_id FROM wakeups WHERE id IN (${marks(ids.length)}) AND done_at IS NULL`)
        .all(...ids);
      this.db
        .prepare(
          `UPDATE wakeups SET done_at = ?, claimed_at = NULL WHERE id IN (${marks(ids.length)})`
        )
        .run(this.now(), ...ids);
      const touched = rows.map((r) => ({ repoId: r.repo_id, jobId: r.job_id }));
      for (const t of touched) this.recoverFromModelError(t.repoId, t.jobId);
      return touched;
    })();
  }

  /**
   * Hand wakeups back after their turn failed, to retry after a backoff. Once
   * they have failed `WAKEUP_GIVE_UP_ATTEMPTS` times the client is told, with
   * a notice card, and the job waits; the wakeups stay queued and keep
   * retrying on the longest step.
   */
  releaseWakeups(input: { ids: number[]; error: string }): ReleaseOutcome {
    if (input.ids.length === 0) return { nextDueAt: null, gaveUp: false, touched: [] };
    return this.db.transaction(() => {
      const now = this.now();
      const rows = this.db
        .prepare<
          unknown[],
          WakeupRow
        >(`SELECT id, repo_id, job_id, kind, question_id, payload_json, attempts FROM wakeups WHERE id IN (${marks(input.ids.length)}) AND done_at IS NULL`)
        .all(...input.ids);
      let gaveUp = false;
      for (const row of rows) {
        const attempts = row.attempts + 1;
        this.db
          .prepare(
            'UPDATE wakeups SET attempts = ?, claimed_at = NULL, not_before = ? WHERE id = ?'
          )
          .run(attempts, now + wakeupBackoffMs(attempts), row.id);
        if (attempts >= WAKEUP_GIVE_UP_ATTEMPTS) gaveUp = true;
      }
      const touched = distinctTouched(rows.map((r) => ({ repoId: r.repo_id, jobId: r.job_id })));
      if (gaveUp) for (const t of touched) this.raiseModelError(t.repoId, t.jobId, input.error);
      const first = touched.at(0);
      return {
        nextDueAt: first ? this.nextDueAt(first.repoId, first.jobId) : null,
        gaveUp,
        touched
      };
    })();
  }

  /** Put up the "cannot reach its model" card for a job, once, and hold the job. */
  private raiseModelError(repoId: string, jobId: number | null, error: string): void {
    const open = this.listQuestions(repoId, { jobId, statuses: ['open'] }).some(
      (q) => q.kind === 'model_unreachable'
    );
    if (open) return;
    this.askQuestion({
      repoId,
      jobId,
      kind: 'model_unreachable',
      question: 'The Admiral cannot reach its model',
      context: `Fleet keeps the work queued and retries every few minutes. The last error: ${error}`,
      options: [{ label: 'Retry' }, { label: 'Open Settings' }],
      recommended: 0
    });
    if (jobId !== null) this.addHold(jobId, 'model', error);
  }

  /** Undo `raiseModelError` once a turn for the job went through. */
  private recoverFromModelError(repoId: string, jobId: number | null): void {
    for (const q of this.listQuestions(repoId, { jobId, statuses: ['open'] })) {
      if (q.kind === 'model_unreachable') this.withdrawCascade(q.id, 'the model answered again');
    }
    if (jobId !== null) this.releaseHold(jobId, 'model');
  }

  /** Make a repository's queued wakeups due now, as the notice card's Retry asks. */
  retryNow(repoId: string): void {
    this.db
      .prepare(
        'UPDATE wakeups SET not_before = 0, attempts = 0 WHERE repo_id = ? AND done_at IS NULL'
      )
      .run(repoId);
  }

  /** Put a repository's claimed, unfinished wakeups back in the queue, as they were. */
  unclaimWakeups(repoId: string): number {
    return this.db
      .prepare(
        'UPDATE wakeups SET claimed_at = NULL WHERE repo_id = ? AND done_at IS NULL AND claimed_at IS NOT NULL'
      )
      .run(repoId).changes;
  }

  /**
   * Release claims older than `maxAgeMs`, for one job (null: the lobby) or for
   * every repository. At startup this runs with 0: no turn from before the
   * restart is still running, so every claim is stale.
   */
  releaseStaleClaims(
    maxAgeMs: number = WAKEUP_STALE_CLAIM_MS,
    scope?: { repoId: string; jobId: number | null }
  ): number {
    const cutoff = this.now() - maxAgeMs;
    const stale = 'done_at IS NULL AND claimed_at IS NOT NULL AND claimed_at <= ?';
    if (scope === undefined) {
      return this.db.prepare(`UPDATE wakeups SET claimed_at = NULL WHERE ${stale}`).run(cutoff)
        .changes;
    }
    return this.db
      .prepare(
        `UPDATE wakeups SET claimed_at = NULL WHERE repo_id = ? AND job_id IS ? AND ${stale}`
      )
      .run(scope.repoId, scope.jobId, cutoff).changes;
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /**
   * What an Admiral pane shows for a repository: its open jobs, its open
   * questions and the most recently settled ones (so a card in the transcript
   * can show how it was answered), and when the next retry is due.
   */
  snapshot(repoId: string): Omit<AgencySnapshot, 'clientFileChanged' | 'held'> {
    const open = this.listQuestions(repoId, { statuses: ['open'] });
    const recent = this.db
      .prepare<[string, number], QuestionRow>(
        `SELECT * FROM questions WHERE repo_id = ? AND status IN ('answered', 'withdrawn')
         ORDER BY id DESC LIMIT ?`
      )
      .all(repoId, SNAPSHOT_RECENT_QUESTIONS)
      .map(toQuestion);
    const retry = this.db
      .prepare<[string], { due: number | null }>(
        `SELECT MIN(not_before) AS due FROM wakeups
         WHERE repo_id = ? AND done_at IS NULL AND claimed_at IS NULL AND attempts > 0`
      )
      .get(repoId);
    return {
      repoId,
      lobbySessionId: this.lobbySessionId(repoId) ?? '',
      jobs: this.listJobs(repoId),
      questions: [...open, ...recent].sort((a, b) => a.id - b.id),
      nextRetryAt: retry?.due ?? null,
      onboarding: this.onboarding(repoId),
      trust: this.preferences.trust(repoId),
      leftovers: this.resources.leftovers(repoId),
      pastJobs: this.pastJobs(repoId),
      settingsCards: this.settings.cards(repoId, SNAPSHOT_SETTINGS_CARDS),
      decisions: this.decisions(repoId)
    };
  }

  /** The client's decisions since local midnight across the repository's jobs, newest first. */
  private decisions(repoId: string): ClientDecision[] {
    const since = startOfDay(this.now());
    const questions = this.db
      .prepare<[string, number, number], QuestionRow>(
        `SELECT * FROM questions WHERE repo_id = ? AND status = 'answered' AND answered_at >= ?
         ORDER BY answered_at DESC, id DESC LIMIT ?`
      )
      .all(repoId, since, DECISIONS_MAX)
      .map(toQuestion);
    return clientDecisions({
      plans: this.plans.decidedByClient(repoId, since, DECISIONS_MAX),
      questions,
      permissions: this.permissions.answeredByClient(repoId, since, DECISIONS_MAX),
      jobState: (jobId) => this.getJob(jobId)?.state ?? null
    });
  }

  /** The repository's last few jobs that ended, newest first. */
  pastJobs(repoId: string, limit = SNAPSHOT_PAST_JOBS): AgencyJob[] {
    return this.db
      .prepare<unknown[], JobRow>(
        `SELECT * FROM jobs WHERE repo_id = ? AND state IN (${marks(TERMINAL_JOB_STATES.length)})
         ORDER BY updated_at DESC, id DESC LIMIT ?`
      )
      .all(repoId, ...TERMINAL_JOB_STATES, limit)
      .map((row) => this.toJob(row));
  }

  /** The client file as Fleet last wrote it, or null when Fleet never has. */
  clientFileMark(repoId: string): string | null {
    return (
      this.db
        .prepare<[string], { text: string }>('SELECT text FROM client_files WHERE repo_id = ?')
        .get(repoId)?.text ?? null
    );
  }

  /** Note what Fleet just wrote to the client file, or what the client kept. */
  markClientFile(repoId: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO client_files (repo_id, text, written_at) VALUES (?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET text = excluded.text, written_at = excluded.written_at`
      )
      .run(repoId, text, this.now());
  }

  /** Whether the client has been through the first-run checks once. */
  firstRunDone(): boolean {
    return (
      this.db
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM agency_meta WHERE key = 'first_run_done_at'")
        .get() !== undefined
    );
  }

  finishFirstRun(): void {
    this.db
      .prepare(
        `INSERT INTO agency_meta (key, value) VALUES ('first_run_done_at', ?)
         ON CONFLICT(key) DO NOTHING`
      )
      .run(String(this.now()));
  }

  /**
   * Whether a Claude Code session has reported from `folder` or a folder in
   * it, so the trust prompt that covers it was answered.
   */
  claudeTrusted(folder: string): boolean {
    const inside = `${folder}${sep}`;
    return (
      this.db
        .prepare<
          [string, string, string],
          { folder: string }
        >('SELECT folder FROM claude_trust WHERE folder = ? OR substr(folder, 1, length(?)) = ? LIMIT 1')
        .get(folder, inside, inside) !== undefined
    );
  }

  /** A Claude Code session reported from `folder`. */
  noteClaudeFolder(folder: string): void {
    this.db
      .prepare(
        `INSERT INTO claude_trust (folder, seen_at) VALUES (?, ?)
         ON CONFLICT(folder) DO NOTHING`
      )
      .run(folder, this.now());
  }

  onboarding(repoId: string): AgencyOnboarding {
    const row = this.db
      .prepare<
        [string],
        { setup_done_at: number | null; starter_done_at: number | null }
      >('SELECT setup_done_at, starter_done_at FROM onboarding WHERE repo_id = ?')
      .get(repoId);
    const starterDoneAt = row?.starter_done_at ?? null;
    const youSeen = this.preferences.meetSeen(YOU_LAYER);
    return {
      setupDoneAt: row?.setup_done_at ?? null,
      starterDoneAt,
      meetDue: starterDoneAt === null || youSeen === null,
      meetLeft: meetLeft({
        youSeen,
        projectSeen: this.preferences.meetSeen(repoId),
        starterDone: starterDoneAt !== null
      })
    };
  }

  /**
   * Note that a repository finished a step of onboarding. Setup can be saved
   * before an Admiral ever opened on the repository, so it is recorded here.
   */
  markOnboarded(repo: AgencyRepoRef, step: 'setup' | 'starter'): AgencyOnboarding {
    const column = step === 'setup' ? 'setup_done_at' : 'starter_done_at';
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO repos (repo_id, root, name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET root = excluded.root, name = excluded.name`
        )
        .run(repo.repoId, repo.root, repo.name, now);
      this.db
        .prepare(
          `INSERT INTO onboarding (repo_id, ${column}) VALUES (?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET ${column} = excluded.${column}`
        )
        .run(repo.repoId, now);
    })();
    return this.onboarding(repo.repoId);
  }

  /**
   * Every project with an Admiral opened before or a setup saved, by name. A
   * repository that is now a member of a workspace project is that project.
   */
  listProjects(): AgencyProjectSummary[] {
    const running = RUNNING_JOB_STATES.map(() => '?').join(', ');
    return this.db
      .prepare<
        JobState[],
        {
          repo_id: string;
          root: string;
          name: string;
          setup_done_at: number | null;
          starter_done_at: number | null;
          running_jobs: number;
          open_questions: number;
        }
      >(
        `SELECT r.repo_id, r.root, r.name, o.setup_done_at, o.starter_done_at,
           (SELECT COUNT(*) FROM jobs j WHERE j.repo_id = r.repo_id AND j.state IN (${running})) AS running_jobs,
           (SELECT COUNT(*) FROM questions q WHERE q.repo_id = r.repo_id AND q.status = 'open') AS open_questions
         FROM repos r LEFT JOIN onboarding o ON o.repo_id = r.repo_id
         WHERE NOT EXISTS (
           SELECT 1 FROM project_members m WHERE m.repo_id = r.repo_id AND m.project_id != r.repo_id
         )
         ORDER BY r.name COLLATE NOCASE, r.root`
      )
      .all(...RUNNING_JOB_STATES)
      .map((row) => ({
        repo: { repoId: row.repo_id, root: row.root, name: row.name },
        setupDoneAt: row.setup_done_at,
        starterDoneAt: row.starter_done_at,
        runningJobs: row.running_jobs,
        openQuestions: row.open_questions
      }));
  }
}
