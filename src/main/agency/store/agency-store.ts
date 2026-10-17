import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENCY_QUESTION_KINDS,
  RUNNING_JOB_STATES,
  TERMINAL_JOB_STATES,
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
  type JobHoldKind,
  type JobState,
  type WakeupPull
} from '../../../shared/agency';
import type { AgencyProjectSummary } from '../../../shared/agency-projects';
import { parseJsonAs } from '../../../shared/parse-json';
import { WAKEUP_GIVE_UP_ATTEMPTS, WAKEUP_STALE_CLAIM_MS, wakeupBackoffMs } from '../backoff';
import { CHAIN_LIMIT, chainExhausted } from '../jobs/chain';
import { reduceJob, type CloseTarget, type JobEvent, type Transition } from '../jobs/job-machine';
import { renderWakeupText, type WakeupItem } from '../wakeup-text';
import { openAgencyDb } from './agency-db';

type JobRow = {
  id: number;
  repo_id: string;
  title: string;
  brief: string;
  state: string;
  session_id: string;
  handoff_done: number;
  budget_usd: number | null;
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
};

export type AnswerOutcome = {
  question: AgencyQuestion;
  /** Hidden questions the answer revealed, because they waited on this option. */
  revealed: number[];
  /** Questions the answer withdrew, because they waited on another option. */
  withdrew: number[];
};

export type EnqueueWakeupInput = {
  repoId: string;
  jobId: number | null;
  kind: 'answer' | 'event';
  questionId?: number | null;
  payload?: Record<string, unknown>;
  /** Higher runs first. Permission requests outrank everything else. */
  priority?: number;
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

const HOLD_KINDS: readonly JobHoldKind[] = ['model', 'chain_limit', 'budget', 'client'];
const CLOSE_TARGETS: readonly CloseTarget[] = ['closed', 'cancelled', 'failed'];

/** How many answered or withdrawn questions a snapshot carries besides the open ones. */
const SNAPSHOT_RECENT_QUESTIONS = 100;

function jobState(raw: string): JobState {
  return JOB_STATES.find((s) => s === raw) ?? 'failed';
}

function questionStatus(raw: string): AgencyQuestionStatus {
  return QUESTION_STATUSES.find((s) => s === raw) ?? 'withdrawn';
}

function toJob(row: JobRow, holds: JobHoldKind[]): AgencyJob {
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
    sessionId: row.session_id,
    handoffDone: row.handoff_done === 1,
    budgetUsd: row.budget_usd,
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

  constructor(db: Database.Database | string, opts: { now?: () => number } = {}) {
    this.db = typeof db === 'string' ? openAgencyDb(db) : db;
    this.now = opts.now ?? Date.now;
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
          `INSERT INTO jobs (repo_id, title, brief, state, session_id, budget_usd, created_at, updated_at)
           VALUES (?, ?, ?, 'briefing', ?, ?, ?, ?)`
        )
        .run(
          input.repoId,
          input.title,
          input.brief,
          input.sessionId,
          input.budgetUsd ?? null,
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
    return toJob(row, this.holds(row.id));
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
    return this.db
      .prepare<unknown[], JobRow>(
        `SELECT * FROM jobs WHERE state IN (${marks(RUNNING_JOB_STATES.length)}) ORDER BY id`
      )
      .all(...RUNNING_JOB_STATES)
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
      return { ...result, job: this.getJob(id) };
    })();
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
    if (!chainExhausted(job.chainCount)) {
      this.db.prepare('UPDATE jobs SET chain_count = chain_count + 1 WHERE id = ?').run(job.id);
      return true;
    }
    if (this.listOpenFleetCards(job.id, 'continue').length === 0) {
      this.askQuestion({
        repoId: job.repoId,
        jobId: job.id,
        kind: 'continue',
        question: `The Admiral took ${CHAIN_LIMIT} turns in a row on its own`,
        context: 'The job waits so it does not run away. Continue to let it go on.',
        options: [
          { label: 'Continue', detail: `${CHAIN_LIMIT} more turns` },
          { label: 'Not now', detail: 'the job waits; send a message to go on' }
        ],
        recommended: 0
      });
    }
    this.addHold(job.id, 'chain_limit');
    return false;
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
             options_json, recommended, dep_question, dep_option, status, withdrawn_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          this.now()
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

      if (q.kind !== 'ask') {
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
        `INSERT INTO wakeups (repo_id, job_id, kind, question_id, payload_json, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.repoId,
        input.jobId,
        input.kind,
        input.questionId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.priority ?? 1,
        this.now()
      );
    return Number(lastInsertRowid);
  }

  /**
   * Claim every wakeup due for one job (null: the lobby) and render them as
   * the text of one turn. Claims gone stale for that job are released first,
   * so a turn lost to a reload does not hold its wakeups forever.
   */
  pullWakeups(input: { repoId: string; jobId: number | null }): WakeupPull {
    return this.db.transaction(() => {
      this.releaseStaleClaims(WAKEUP_STALE_CLAIM_MS, input);
      const now = this.now();
      const rows = this.db
        .prepare<[string, number | null, number], WakeupRow>(
          `SELECT id, repo_id, job_id, kind, question_id, payload_json, attempts FROM wakeups
           WHERE repo_id = ? AND job_id IS ? AND done_at IS NULL AND claimed_at IS NULL AND not_before <= ?
           ORDER BY priority DESC, id`
        )
        .all(input.repoId, input.jobId, now);
      const job = input.jobId === null ? null : this.getJob(input.jobId);
      if (job?.holds.includes('chain_limit')) return { ids: [], text: null, nextDueAt: null };
      if (job && rows.length > 0 && !this.countAutomaticTurn(job)) {
        return { ids: [], text: null, nextDueAt: null };
      }
      if (rows.length > 0) {
        this.db
          .prepare(`UPDATE wakeups SET claimed_at = ? WHERE id IN (${marks(rows.length)})`)
          .run(now, ...rows.map((r) => r.id));
      }
      return {
        ids: rows.map((r) => r.id),
        text: renderWakeupText(rows.flatMap((r) => this.wakeupItem(r))),
        nextDueAt: this.nextDueAt(input.repoId, input.jobId)
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
    const event = parseJsonAs(EventPayload, row.payload_json);
    return event ? [{ kind: 'event', line: event.line, body: event.body ?? null }] : [];
  }

  /** When the next unclaimed wakeup for a job becomes due, or null when none waits. */
  private nextDueAt(repoId: string, jobId: number | null): number | null {
    const row = this.db
      .prepare<[string, number | null], { due: number | null }>(
        `SELECT MIN(not_before) AS due FROM wakeups
         WHERE repo_id = ? AND job_id IS ? AND done_at IS NULL AND claimed_at IS NULL`
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
  snapshot(repoId: string): AgencySnapshot {
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
      onboarding: this.onboarding(repoId)
    };
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

  onboarding(repoId: string): AgencyOnboarding {
    const row = this.db
      .prepare<
        [string],
        { setup_done_at: number | null; starter_done_at: number | null }
      >('SELECT setup_done_at, starter_done_at FROM onboarding WHERE repo_id = ?')
      .get(repoId);
    return { setupDoneAt: row?.setup_done_at ?? null, starterDoneAt: row?.starter_done_at ?? null };
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

  /** Every repository with an Admiral opened before or a setup saved, by name. */
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
