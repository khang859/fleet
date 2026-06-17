import { dirname } from 'path';
import { z } from 'zod';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task, RunMode, Feature } from '../../shared/kanban-types';
import { computeNextRun, taskToScheduleInput } from './schedule';
import {
  ensureFeatureBranch,
  checkMergeConflicts,
  createFeaturePr,
  finalizeWorktree,
  headSha,
  isBranchMerged,
  markPrReady,
  mergeWorktreeToBase,
  pushIntegrationBranch,
  removeWorktree,
  updateIntegrationBranchFromMain
} from './workspace';
import { readLogTail } from './spawn-worker';
import { expandTemplate, PIPELINE_EXPANDED_EVENT } from './template-expander';
import { getTemplate, QA_ATTEMPT_CAP } from './pipeline-templates';

const log = createLogger('kanban-dispatcher');

const DEFAULT_INTERVAL_MS = 5000;

/** Minimum gap between merged-worktree prune sweeps (a periodic safety net, not the fast path). */
const WORKTREE_SWEEP_INTERVAL_MS = 300_000;

/** Min gap between grouping-detection runs for the same repo (debounce; spec §4). */
const SUGGEST_COOLDOWN_MS = 30 * 60_000;

/** A pipeline whose current stage is idle longer than this is flagged stale (spec §12). */
const PIPELINE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Exit code rune returns from a `--require-tool` run that ended without the
 * model calling a completion tool (it was nudged to the cap and gave up). Kept
 * in sync with rune's main.go. Distinct from a crash so we route to review
 * instead of burning the crash-retry budget.
 */
const REVIEW_REQUIRED_EXIT_CODE = 3;

/**
 * Assign runs attempted before the dispatcher falls back to the default worker profile.
 * MUST stay below the default failureLimit (3) so the deterministic fallback fires before
 * a task is ever given up/blocked. At cap=2, failureLimit=3 this holds.
 */
const ASSIGN_ATTEMPT_CAP = 2;

/** Resolve runs attempted per task before it is blocked. Tracked in tasks.resolve_attempts (independent of failureLimit). */
const RESOLVE_ATTEMPT_CAP = 2;
/** Verify-fix work runs attempted per task before it is blocked. Tracked in tasks.verify_attempts. */
const VERIFY_ATTEMPT_CAP = 2;
/** Claim lease re-granted each tick while a verify shell is still running (mirrors kanban_complete). */
const VERIFY_CLAIM_TTL_MS = 15 * 60 * 1000;
/** Max task merges + resolve spawns processed per integrate() tick, so the tick stays fast. */
const MAX_INTEGRATE_PER_TICK = 3;
/** Max review runs spawned per tick. */
const MAX_REVIEW_PER_TICK = 3;
/** Review-fix work runs attempted per task before soft-escalation. Tracked in tasks.review_attempts. */
const REVIEW_ATTEMPT_CAP = 2;

/** Git ops used by integrate(); injectable so the stage is unit-testable. Defaults to the real workspace.ts fns. */
export interface IntegrationOps {
  ensureFeatureBranch: typeof ensureFeatureBranch;
  checkMergeConflicts: typeof checkMergeConflicts;
  mergeWorktreeToBase: typeof mergeWorktreeToBase;
  updateIntegrationBranchFromMain: typeof updateIntegrationBranchFromMain;
  removeWorktree: typeof removeWorktree;
  isBranchMerged: typeof isBranchMerged;
  createFeaturePr: typeof createFeaturePr;
  pushIntegrationBranch: typeof pushIntegrationBranch;
  markPrReady: typeof markPrReady;
  headSha: typeof headSha;
}

const DEFAULT_INTEGRATION_OPS: IntegrationOps = {
  ensureFeatureBranch,
  checkMergeConflicts,
  mergeWorktreeToBase,
  updateIntegrationBranchFromMain,
  removeWorktree,
  isBranchMerged,
  createFeaturePr,
  pushIntegrationBranch,
  markPrReady,
  headSha
};

export interface SpawnWorkerArgs {
  task: Task;
  runId: number;
  lock: string;
  workspace: string;
  mode: RunMode;
  /** Prior verify failure output, injected into the work prompt for a verify-fix run. */
  verifyFailure?: string;
  /** Prior review findings, injected into a bounce work prompt for a review-fix run. */
  reviewFindings?: string;
}

export interface DispatcherConfig {
  failureLimit: number; // consecutive failures before gave_up
  claimGraceMs: number; // protect freshly-spawned workers from reclaim
  maxInProgress: number; // concurrency cap
  claimTtlMs: number; // claim lease length
  autoDecompose: boolean; // automatically arm triage tasks for decompose
  autoAssign: boolean; // automatically assign unassigned ready tasks to a worker profile
  autoIntegrate: boolean; // auto-merge feature review tasks into the integration branch + resolve runs
  autoReview: boolean; // gate completed worktree tasks through an agent review run
  maxDecompose: number; // max concurrent orchestrator runs
  artifactRetentionDays: number; // auto-purge discarded artifacts older than this; 0 disables
}

export interface WorkerExit {
  code: number | null;
  signal: string | null;
  // The real cause of death, extracted from the worker log at exit time (a rune
  // `[error: …]`: auth failure, provider 4xx, etc.). Surfaced in place of the
  // cryptic "pid not alive" reclaim reason.
  fatalReason?: string;
  // Deterministic failure (auth/credentials, or an instant startup crash) that
  // retrying cannot fix — block immediately instead of spending the retry budget.
  blockNow?: boolean;
}

export interface DispatcherDeps {
  now: () => number;
  isAlive: (pid: number) => boolean;
  spawnWorker: (args: SpawnWorkerArgs) => number | undefined; // returns pid
  config: DispatcherConfig;
  prepareWorkspaceFn?: (task: Task) => string;
  intervalMs?: number;
  // How a worker process exited, if we observed it (in-memory; absent after a
  // restart). Lets reclaim() classify a clean "didn't complete" exit distinctly
  // from a crash. clearWorkerExit drops the entry once consumed.
  workerExit?: (runId: number) => WorkerExit | undefined;
  clearWorkerExit?: (runId: number) => void;
  /** runId-deterministic verify log path; the dispatcher reads the tail for the failure comment. */
  verifyLogPath?: (runId: number) => string;
  /** Worker-role profile names (in profile order), for the auto-assign fast path and fallback. */
  workerProfileNames?: () => string[];
  /** All profile role names present, for the pipeline expander's graceful-degradation check. */
  profileRoles?: () => string[];
  /** Git ops for integrate(); injected in tests, defaults to real workspace.ts fns. */
  integration?: IntegrationOps;
}

export class KanbanDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private genLock = 0;
  private lastWorktreeSweepAt = 0;
  private lastSuggestAtByRepo = new Map<string, number>();

  constructor(
    private store: KanbanStore,
    private deps: DispatcherDeps
  ) {}

  private get ops(): IntegrationOps {
    return this.deps.integration ?? DEFAULT_INTEGRATION_OPS;
  }

  /** Return expired/dead running tasks to ready, or give up past the failure limit. */
  reclaim(): void {
    const now = this.deps.now();
    for (const task of this.store.runningTasks()) {
      const exit =
        task.currentRunId != null ? this.deps.workerExit?.(task.currentRunId) : undefined;
      const expired = task.claimExpires != null && task.claimExpires <= now;
      const fresh =
        task.lastHeartbeatAt != null && now - task.lastHeartbeatAt < this.deps.config.claimGraceMs;
      const dead = task.workerPid != null && !fresh && !this.deps.isAlive(task.workerPid);
      // A definitive exit event means the process is provably gone — reclaim it
      // now, bypassing the heartbeat grace that only guards against false reaps
      // of a still-live worker.
      if (!expired && !dead && exit == null) continue;

      // A terminal suggest run: its system task is transient and must never be parked on the
      // board (blocked/triage) — that would also wedge the per-repo detection gate forever.
      // Drop it on every terminal path (exit 3, fatal blockNow, dead pid, expired claim).
      const reclaimMode =
        task.currentRunId != null ? this.store.runMode(task.currentRunId) : 'work';
      if (reclaimMode === 'suggest') {
        if (task.currentRunId != null) {
          this.store.finishRun(task.currentRunId, 'reclaimed', {
            error: exit?.fatalReason ?? 'suggest run ended without a suggestion'
          });
          this.deps.clearWorkerExit?.(task.currentRunId);
        }
        this.store.deleteTask(task.id);
        continue;
      }

      // A terminal verify run: read the shell exit code as pass/fail BEFORE the
      // agent-oriented exit-3 / blockNow branches below (test runners routinely
      // exit 3, which REVIEW_REQUIRED would otherwise misread as review-required).
      if (reclaimMode === 'verify') {
        const runId = task.currentRunId;
        if (exit == null) {
          // A long-running verify (large test/build) can outlive the claim window.
          // While the verify shell is still alive, keep waiting — re-extend the claim
          // rather than failing the gate open and orphaning the shell.
          if (task.workerPid != null && this.deps.isAlive(task.workerPid)) {
            if (task.claimLock) this.store.extendClaim(task.id, task.claimLock, VERIFY_CLAIM_TTL_MS);
            continue;
          }
          if (runId != null)
            this.store.finishRun(runId, 'reclaimed', { error: 'verify outcome unknown' });
          this.reviewFromVerify(task, 'verify outcome unknown');
        } else if (exit.code === 0) {
          if (runId != null) this.store.finishRun(runId, 'completed');
          this.reviewFromVerify(task, null);
        } else {
          const label = this.lastVerifyLabel(runId);
          if (runId != null) {
            this.store.finishRun(runId, 'failed', {
              error: `verify failed: ${label} (exit ${exit.code})`
            });
          }
          if (task.verifyAttempts >= VERIFY_ATTEMPT_CAP) {
            const note = `verify failed after ${VERIFY_ATTEMPT_CAP} attempt(s): ${label}`;
            this.store.blockTask(task.id, note);
            this.store.appendEvent(task.id, runId, 'blocked', { reason: note });
            log.warn('verify gave up', { taskId: task.id, label });
          } else {
            const tail =
              runId != null && this.deps.verifyLogPath
                ? readLogTail(this.deps.verifyLogPath(runId))
                : '';
            const logRef =
              runId != null && this.deps.verifyLogPath
                ? `\n(full log: ${this.deps.verifyLogPath(runId)})`
                : '';
            this.store.addComment(task.id, 'verify', `verify failed: ${label}\n${tail}${logRef}`);
            this.store.appendEvent(task.id, runId, 'verify_failed', { label });
            this.spawnVerifyFix(task, tail);
          }
        }
        if (runId != null) this.deps.clearWorkerExit?.(runId);
        continue;
      }

      // A terminal review run: kanban_review_verdict already recorded the verdict + finished the
      // run + emitted review_passed/review_changes_requested (it leaves the task parked 'running'
      // with current_run_id intact). This branch ONLY routes that parked task — it must not emit
      // review_passed and must not double-finishRun when a verdict exists.
      if (reclaimMode === 'review') {
        const runId = task.currentRunId;
        // A long review (large diff) can outlive its claim window. While the reviewer is still
        // alive, keep waiting — re-extend the claim rather than orphaning the run.
        if (exit == null && task.workerPid != null && this.deps.isAlive(task.workerPid)) {
          if (task.claimLock) this.store.extendClaim(task.id, task.claimLock, VERIFY_CLAIM_TTL_MS);
          continue;
        }
        const verdict = task.reviewVerdict;
        if (verdict === 'approve') {
          // The verdict tool already finished the run + emitted review_passed. The verdict
          // and head_sha persist through setStatusCleared (it clears only claim/run fields).
          this.store.setStatusCleared(task.id, 'review');
          this.store.resetReviewAttempts(task.id);
        } else if (verdict === 'request_changes' && task.reviewAttempts < REVIEW_ATTEMPT_CAP) {
          this.spawnReviewFix(task, this.lastReviewFindings(task.id));
        } else {
          // At cap (verdict recorded by the tool), or inconclusive (no verdict — the agent ended
          // without calling the tool, so the run was never finished). Soft-escalate to human review.
          if (verdict == null && runId != null) this.store.finishRun(runId, 'reclaimed');
          this.store.setStatusCleared(task.id, 'review'); // verdict (if any) persists → integrate skips it
          const reason =
            verdict === 'request_changes'
              ? `review requested changes after ${REVIEW_ATTEMPT_CAP} attempt(s)`
              : 'reviewer returned no verdict';
          this.store.appendEvent(task.id, runId, 'review_escalated', { reason });
          this.store.addComment(task.id, 'dispatcher', reason);
        }
        if (runId != null) this.deps.clearWorkerExit?.(runId);
        continue;
      }

      // Clean exit without a terminal tool: rune nudged to its cap and gave up
      // (exit 3). This is deterministic — retrying re-rolls the same wall — so
      // route to a deliberate review-required block, and do NOT count it as a
      // crash against the retry budget. A definitive exit-3 is the known cause,
      // so it wins even if the claim lease also happened to expire this tick.
      if (exit?.code === REVIEW_REQUIRED_EXIT_CODE) {
        const note = 'review-required: agent ended turn without completing';
        // Preserve whatever the agent did before it went quiet: commit the
        // worktree so the block leaves a reviewable branch, not loose edits.
        if (task.workspaceKind === 'worktree' && task.workspacePath) {
          finalizeWorktree({
            workspacePath: task.workspacePath,
            taskId: task.id,
            title: task.title
          });
        }
        if (task.currentRunId != null) {
          this.store.finishRun(task.currentRunId, 'incomplete', { summary: note });
        }
        this.store.blockTask(task.id, note);
        this.store.appendEvent(task.id, task.currentRunId, 'blocked', { reason: note });
        if (task.currentRunId != null) this.deps.clearWorkerExit?.(task.currentRunId);
        log.warn('task needs review', { taskId: task.id });
        continue;
      }

      // A deterministic, retry-proof failure (auth/credentials, or a crash within
      // the startup window): route it straight to a definitive block with the real
      // cause, instead of burning the retry budget on repeated cryptic reclaims.
      if (exit?.blockNow && exit.fatalReason) {
        if (task.currentRunId != null) {
          this.store.finishRun(task.currentRunId, 'crashed', { error: exit.fatalReason });
          this.deps.clearWorkerExit?.(task.currentRunId);
        }
        this.store.blockTask(task.id, exit.fatalReason);
        this.store.appendEvent(task.id, task.currentRunId, 'blocked', { reason: exit.fatalReason });
        log.warn('worker blocked on fatal exit', { taskId: task.id, reason: exit.fatalReason });
        continue;
      }

      // Prefer the worker's own logged error over the cryptic "pid not alive" so a
      // retried-then-given-up task carries the real cause (e.g. a provider 4xx).
      const reason = exit?.fatalReason ?? (expired ? 'claim expired' : 'worker pid not alive');
      if (task.currentRunId != null) {
        this.store.finishRun(task.currentRunId, 'reclaimed', { error: reason });
        this.deps.clearWorkerExit?.(task.currentRunId);
      }
      this.store.recordFailure(task.id, reason);
      this.store.appendEvent(task.id, task.currentRunId, 'reclaimed', { reason });

      const failures = this.store.getTask(task.id)?.consecutiveFailures ?? 0;
      if (failures >= this.deps.config.failureLimit) {
        this.store.giveUp(task.id, reason);
        this.store.appendEvent(task.id, null, 'gave_up', { reason });
        log.warn('task gave up', { taskId: task.id, failures });
      } else {
        const mode = task.currentRunId != null ? this.store.runMode(task.currentRunId) : 'work';
        // assign and resolve are non-work modes that run on a real task (ready/review), not a
        // triage card — they MUST be routed before the generic non-work branch below, or a dead
        // run would wrongly land in triage. A resolve run returns to review so the next
        // integrate() pass re-evaluates it (retry within the cap, or block).
        if (mode === 'assign') this.store.returnToReady(task.id);
        else if (mode === 'resolve') this.store.setStatusCleared(task.id, 'review');
        else if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
        else this.store.returnToReady(task.id);
      }
    }
  }

  /** Promote todo tasks whose parents are all done to ready. */
  promote(): void {
    for (const task of this.store.promotableTodoTasks()) {
      this.store.setStatus(task.id, 'ready');
      this.store.appendEvent(task.id, null, 'promoted', {});
    }
  }

  private graceMs(): number {
    return Math.max(2 * (this.deps.intervalMs ?? DEFAULT_INTERVAL_MS), 60_000);
  }

  /** Fire due schedules: one-shots run in place; recurring templates spawn instances
   *  (or realign past the grace window). Synchronous — preserves the atomic-tick invariant. */
  fireSchedules(): void {
    const now = this.deps.now();
    const grace = this.graceMs();
    for (const t of this.store.dueSchedules(now)) {
      if (t.scheduleKind === 'once') {
        this.store.fireOnce(t.id);
        this.store.appendEvent(t.id, null, 'schedule_fired', { kind: 'once' });
        continue;
      }
      const input = taskToScheduleInput(t);
      if (!input) {
        // defensive: a scheduled row whose recurrence columns are missing/corrupt. It would
        // otherwise be re-selected by dueSchedules every tick and skipped silently — log it.
        log.warn('fireSchedules: due task has no usable recurrence; skipping', { taskId: t.id });
        continue;
      }
      const next = computeNextRun(input, now);
      if (t.nextRunAt != null && now - t.nextRunAt > grace) {
        this.store.advanceNextRun(t.id, next);
        this.store.appendEvent(t.id, null, 'schedule_realigned', { nextRunAt: next });
      } else {
        const instance = this.store.spawnScheduledInstance(t);
        this.store.advanceNextRun(t.id, next);
        this.store.appendEvent(t.id, null, 'schedule_fired', {
          kind: t.scheduleKind,
          instanceId: instance.id
        });
      }
    }
  }

  private nextLock(): string {
    this.genLock += 1;
    return `${this.deps.now()}-${this.genLock}`;
  }

  /** The run mode for a ready pipeline-stage task; non-pipeline ready tasks are plain 'work'. */
  private modeForReadyTask(task: Task): RunMode {
    if (task.pipelineStage === 'explore') return 'explore';
    if (task.pipelineStage === 'spec') return 'spec';
    if (task.pipelineStage === 'qa') return 'qa';
    return 'work';
  }

  claimAndSpawn(): void {
    const cap = this.deps.config.maxInProgress;
    const ttl = this.deps.config.claimTtlMs;
    let slots = cap - this.store.runningTasks().length;
    if (slots <= 0) return;

    for (const task of this.store.readyTasks()) {
      if (slots <= 0) break;
      const lock = this.nextLock();
      if (!this.store.claimTask(task.id, lock, ttl)) continue; // lost the race

      this.store.clearReviewVerdict(task.id);
      this.store.resetReviewAttempts(task.id); // a fresh human-initiated work cycle starts a new review episode

      let pid: number | undefined;
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, task.assignee, null);
        runId = run.id;
        const mode = this.modeForReadyTask(task);
        pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode });
        if (pid != null) {
          this.store.setWorkerPid(task.id, run.id, pid);
        }
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null });
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) {
          this.store.finishRun(runId, 'spawn_failed', { error: msg });
        }
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg });
        this.store.returnToReady(task.id);
        log.error('spawn failed', { taskId: task.id, error: msg });
      }
    }
  }

  /** Claim flagged triage tasks and spawn orchestrator (decompose/specify) runs. */
  decompose(): void {
    let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
    if (slots <= 0) return;
    if (this.deps.config.autoDecompose) {
      this.store.armTriageForDecompose(slots);
    }
    const ttl = this.deps.config.claimTtlMs;
    for (const task of this.store.pendingDecomposeTasks()) {
      if (slots <= 0) break;
      const mode = task.pendingMode;
      if (mode == null) continue;

      // Full-feature pipeline roots are expanded deterministically (no orchestrator). A root
      // that already carries the expansion marker was processed on a prior tick: a successful
      // expansion would have completed the root (so it wouldn't be a pending triage task here),
      // which means this one was degraded to quick_fix — fall through to the orchestrator so it
      // runs today's flow instead of looping back into the expander forever.
      const alreadyExpanded =
        task.pipelineTemplate === 'full_feature' &&
        this.store.listEvents(task.id).some((e) => e.kind === PIPELINE_EXPANDED_EVENT);
      if (task.pipelineTemplate === 'full_feature' && !alreadyExpanded) {
        const lock = this.nextLock();
        if (!this.store.claimForDecompose(task.id, lock, ttl)) continue; // lost the race
        const roles = new Set(this.deps.profileRoles?.() ?? []);
        try {
          expandTemplate(task, getTemplate(task.pipelineTemplate), this.store, {
            hasRole: (r) => roles.has(r)
          });
          // A successful expansion completes the root (it leaves 'running'). If the root is
          // still 'running', expansion was a graceful-degradation no-op (a required SDLC role
          // was missing): release the claim back to triage so the next tick takes the
          // fall-through orchestrator path above instead of reclaiming a dead work run.
          if (this.store.getTask(task.id)?.status === 'running') {
            this.store.setStatusCleared(task.id, 'triage');
            this.store.setPendingMode(task.id, mode);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.store.blockTask(task.id, `pipeline expansion failed: ${msg}`);
          log.error('pipeline expand failed', { taskId: task.id, error: msg });
        }
        slots -= 1;
        continue;
      }

      const lock = this.nextLock();
      if (!this.store.claimForDecompose(task.id, lock, ttl)) continue; // lost the race
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'orchestrator', null, mode);
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode });
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg });
        this.store.setStatusCleared(task.id, 'triage');
        this.store.setPendingMode(task.id, mode); // re-flag so the request isn't lost
        log.error('decompose spawn failed', { taskId: task.id, error: msg });
      }
    }
  }

  /** Assign unassigned ready tasks to a worker profile, either in code (fast path / fallback)
   *  or by spawning an orchestrator assign run (multi-profile LLM path). */
  autoAssign(): void {
    if (!this.deps.config.autoAssign) return;
    const workerNames = this.deps.workerProfileNames?.() ?? [];
    if (workerNames.length === 0) return;
    let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
    const ttl = this.deps.config.claimTtlMs;

    for (const task of this.store.unassignedReadyTasks()) {
      if (workerNames.length === 1 || task.consecutiveFailures >= ASSIGN_ATTEMPT_CAP) {
        const name = workerNames[0];
        const by = workerNames.length === 1 ? 'single-profile' : 'fallback';
        this.store.updateTask(task.id, { assignee: name });
        // assign phase done — reset failures so they don't eat the work phase's retry budget
        this.store.clearFailures(task.id);
        this.store.appendEvent(task.id, null, 'assigned', { assignee: name, by });
        if (by === 'fallback') {
          this.store.addComment(
            task.id,
            'dispatcher',
            `Auto-assigned ${name} after ${task.consecutiveFailures} failed assignment attempt(s).`
          );
        }
        continue;
      }
      // Only the LLM-spawn path is bounded by orchestrator slots; skip (don't break)
      // so later deterministic tasks still get assigned in code this tick.
      if (slots <= 0) continue;
      const lock = this.nextLock();
      if (!this.store.claimForAssign(task.id, lock, ttl)) continue;
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'orchestrator', null, 'assign');
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'assign' });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode: 'assign' });
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg });
        this.store.returnToReady(task.id);
        log.error('assign spawn failed', { taskId: task.id, error: msg });
      }
    }
  }

  /**
   * Detect loose tickets worth grouping (spec §4): for each repo with ≥2 ungrouped worktree
   * tasks in todo/ready, spawn one PM `suggest` run (on a transient system task) that may record
   * a pending grouping suggestion. Debounced per repo; gated by the orchestrator-slot budget.
   * Nothing is regrouped here — the suggestion only surfaces a banner for a human to Accept.
   */
  detectFeatureGroups(): void {
    let slots = this.deps.config.maxDecompose - this.store.orchestratorRunningCount();
    if (slots <= 0) return;
    const now = this.deps.now();

    // group candidates by board+repo
    const byRepo = new Map<string, Task[]>();
    for (const t of this.store.ungroupedWorktreeReadyTodoTasks()) {
      if (!t.repoPath) continue;
      const key = `${t.boardId} ${t.repoPath}`;
      const list = byRepo.get(key) ?? [];
      list.push(t);
      byRepo.set(key, list);
    }

    for (const [key, tasks] of byRepo) {
      if (slots <= 0) break;
      if (tasks.length < 2) continue;
      // boardId/repoPath are shared across the group by construction; read them from the
      // first task rather than splitting the key (a repoPath may contain spaces on macOS).
      const boardId = tasks[0].boardId;
      const repoPath = tasks[0].repoPath;
      if (!repoPath) continue; // defensive; the candidate query already guarantees non-null
      const last = this.lastSuggestAtByRepo.get(key);
      if (last != null && now - last < SUGGEST_COOLDOWN_MS) continue;
      if (this.store.hasOpenSuggestTask(boardId, repoPath)) continue;
      if (this.store.listSuggestions(boardId, { status: 'pending', repoPath }).length > 0) continue;

      const body =
        `These ungrouped tasks share the repo ${repoPath}:\n` +
        tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n') +
        `\n\nIf a coherent subset should ship together as one feature, call kanban_suggest_feature ` +
        `with a feature name, those task ids, and a one-line reason. If nothing is clearly related, ` +
        `call kanban_block.`;

      const sys = this.store.createTask({
        title: `Suggest a feature grouping for ${repoPath}`,
        body,
        status: 'review', // claimForSuggest claims from review
        boardId,
        systemKind: 'suggest',
        workspaceKind: 'dir',
        workspacePath: repoPath,
        repoPath
      });

      const lock = this.nextLock();
      if (!this.store.claimForSuggest(sys.id, lock, this.deps.config.claimTtlMs)) {
        this.store.deleteTask(sys.id);
        continue;
      }
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(sys)
          : (sys.workspacePath ?? '');
        const run = this.store.startRun(sys.id, 'orchestrator', null, 'suggest');
        runId = run.id;
        const pid = this.deps.spawnWorker({
          task: sys,
          runId: run.id,
          lock,
          workspace,
          mode: 'suggest'
        });
        if (pid != null) this.store.setWorkerPid(sys.id, run.id, pid);
        this.store.appendEvent(sys.id, run.id, 'spawned', { pid: pid ?? null, mode: 'suggest' });
        this.lastSuggestAtByRepo.set(key, now);
        slots -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.deleteTask(sys.id); // never park a detection task on the board
        log.error('suggest spawn failed', { repoPath, error: msg });
      }
    }
  }

  /** The feature integration branch a task merges into (or null for a standalone task / missing feature). */
  private integrationBranchFor(featureId: string | null): string | null {
    if (!featureId) return null;
    const f = this.store.getFeature(featureId);
    if (!f) return null;
    return f.integrationBranch ?? `fleet/feature-${f.id}`;
  }

  /**
   * Spawn a resolve run for a review task (or block it past the cap). Returns true if a run was spawned.
   * The worker merges `target` into the task's worktree, resolves, commits, and completes (-> review).
   */
  private spawnResolve(task: Task, target: string): boolean {
    const attempts = task.resolveAttempts;
    if (attempts >= RESOLVE_ATTEMPT_CAP) {
      const note = `merge conflicts unresolved after ${RESOLVE_ATTEMPT_CAP} resolve attempt(s)`;
      this.store.blockTask(task.id, note);
      this.store.appendEvent(task.id, null, 'blocked', { reason: note });
      log.warn('resolve gave up', { taskId: task.id, attempts });
      return false;
    }
    const lock = this.nextLock();
    if (!this.store.claimForResolve(task.id, lock, this.deps.config.claimTtlMs)) return false; // lost race
    this.store.clearReviewVerdict(task.id); // a resolve changes the tree → re-review the result
    let runId: number | null = null;
    try {
      let workspace = task.workspacePath ?? '';
      if (!workspace && this.deps.prepareWorkspaceFn) {
        workspace = this.deps.prepareWorkspaceFn(task); // creates the worktree (e.g. for a system task)
      }
      const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'resolve');
      runId = run.id;
      this.store.incrementResolveAttempts(task.id);
      const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'resolve' });
      if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
      this.store.appendEvent(task.id, run.id, 'spawned', {
        pid: pid ?? null,
        mode: 'resolve',
        target,
        attempt: attempts + 1
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'resolve' });
      this.store.setStatusCleared(task.id, 'review'); // hand back to review so a later tick retries
      log.error('resolve spawn failed', { taskId: task.id, error: msg });
      return false;
    }
  }

  /** Move a task from a finished verify run into review, recovering the work run's summary. */
  private reviewFromVerify(task: Task, skipReason: string | null): void {
    const work = this.store
      .listRuns(task.id)
      .find((r) => r.mode === 'work' && r.outcome === 'completed');
    const summary = work?.summary ?? null;
    this.store.reviewTask(task.id, summary);
    // A clean trip through the gate to review clears the fix budget so a later
    // verify cycle (e.g. after an integrate resolve) starts with the full cap.
    this.store.resetVerifyAttempts(task.id);
    if (task.repoPath && task.branchName && task.baseBranch) {
      const c = this.ops.checkMergeConflicts({
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        branchName: task.branchName
      });
      this.store.setTaskConflict(task.id, c.state, c.files);
    }
    if (skipReason) {
      this.store.appendEvent(task.id, null, 'verify_skipped', { reason: skipReason });
    } else {
      const labels = this.verifyLabelsFor(task);
      this.store.appendEvent(task.id, null, 'verify_passed', { labels });
    }
  }

  /** The verify command labels configured for a task's project (for the verify_passed event). */
  private verifyLabelsFor(task: Task): string[] {
    if (!task.repoPath) return [];
    const project = this.store.getProjectByPath(task.boardId, task.repoPath);
    return (project?.verifyCommands ?? []).map((c) => c.label);
  }

  /** The label of the last verify command that started (= the one that failed), parsed from the log. */
  private lastVerifyLabel(runId: number | null): string {
    if (runId == null || !this.deps.verifyLogPath) return 'verify';
    const tail = readLogTail(this.deps.verifyLogPath(runId));
    const matches = [...tail.matchAll(/=== verify: (.+?) ===/g)];
    return matches.length ? matches[matches.length - 1][1] : 'verify';
  }

  /** Spawn a fresh `work` run on the same worktree to fix a verify failure. */
  private spawnVerifyFix(task: Task, failureTail: string): boolean {
    const lock = this.nextLock();
    if (!this.store.claimForVerifyFix(task.id, lock, this.deps.config.claimTtlMs)) return false;
    let runId: number | null = null;
    try {
      const workspace = task.workspacePath ?? '';
      const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'work');
      runId = run.id;
      this.store.incrementVerifyAttempts(task.id);
      const pid = this.deps.spawnWorker({
        task,
        runId: run.id,
        lock,
        workspace,
        mode: 'work',
        verifyFailure: failureTail
      });
      if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
      this.store.appendEvent(task.id, run.id, 'spawned', {
        pid: pid ?? null,
        mode: 'work',
        reason: 'verify-fix',
        attempt: task.verifyAttempts + 1
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'work' });
      this.store.setStatusCleared(task.id, 'ready');
      log.error('verify-fix spawn failed', { taskId: task.id, error: msg });
      return false;
    }
  }

  /** The findings from the most recent request_changes event, formatted for the bounce prompt. */
  private lastReviewFindings(taskId: string): string {
    const ev = [...this.store.listEvents(taskId)]
      .reverse()
      .find((e) => e.kind === 'review_changes_requested');
    const parsed = z
      .object({
        summary: z.string().optional(),
        findings: z.array(z.object({ file: z.string().optional(), note: z.string() })).optional()
      })
      .safeParse(ev?.payload);
    const p = parsed.success ? parsed.data : {};
    const lines = (p.findings ?? []).map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.note}`);
    return [p.summary, ...lines].filter(Boolean).join('\n');
  }

  /** Spawn a fresh `work` run to address review findings (mirrors spawnVerifyFix). */
  private spawnReviewFix(task: Task, findings: string): boolean {
    const lock = this.nextLock();
    if (!this.store.claimForVerifyFix(task.id, lock, this.deps.config.claimTtlMs)) return false;
    this.store.clearReviewVerdict(task.id); // diff will change → drop the prior verdict
    this.store.incrementReviewAttempts(task.id);
    let runId: number | null = null;
    try {
      const workspace = task.workspacePath ?? '';
      const run = this.store.startRun(task.id, task.assignee ?? 'worker', null, 'work');
      runId = run.id;
      const pid = this.deps.spawnWorker({
        task,
        runId: run.id,
        lock,
        workspace,
        mode: 'work',
        reviewFindings: findings
      });
      if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
      this.store.appendEvent(task.id, run.id, 'spawned', {
        pid: pid ?? null,
        mode: 'work',
        reason: 'review-fix',
        attempt: task.reviewAttempts + 1
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.recordFailure(task.id, msg);
      if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
      this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'work' });
      this.store.setStatusCleared(task.id, 'ready');
      log.error('review-fix spawn failed', { taskId: task.id, error: msg });
      return false;
    }
  }

  /**
   * Public entry for the standalone manual-merge-conflict path (KanbanCommands.mergeReviewTask).
   * Resolves against the task's merge target (its integration branch for a feature task, else its base).
   */
  requestResolve(taskId: string): boolean {
    const task = this.store.getTask(taskId);
    if (task?.status !== 'review') return false;
    const target = this.integrationBranchFor(task.featureId) ?? task.baseBranch;
    if (!target) return false;
    return this.spawnResolve(task, target);
  }

  /** Spawn an agent review run for each review-pending worktree task (gated on autoReview). */
  reviewTasks(): void {
    if (!this.deps.config.autoReview) return;
    let budget = MAX_REVIEW_PER_TICK;
    const ttl = this.deps.config.claimTtlMs;
    for (const task of this.store.reviewPendingTasks()) {
      if (budget <= 0) break;
      if (this.store.isSwarmMember(task.id)) continue; // swarms carry their own verifier card
      const lock = this.nextLock();
      if (!this.store.claimForReview(task.id, lock, ttl)) continue; // lost race
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, 'reviewer', null, 'review');
        runId = run.id;
        const pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'review' });
        if (pid != null) this.store.setWorkerPid(task.id, run.id, pid);
        this.store.appendEvent(task.id, run.id, 'spawned', { pid: pid ?? null, mode: 'review' });
        budget -= 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.store.recordFailure(task.id, msg);
        if (runId != null) this.store.finishRun(runId, 'spawn_failed', { error: msg });
        this.store.appendEvent(task.id, runId, 'spawn_failed', { error: msg, mode: 'review' });
        const failures = this.store.getTask(task.id)?.consecutiveFailures ?? 0;
        if (failures >= this.deps.config.failureLimit) {
          // Persistent spawn failure: stop bouncing forever — soft-escalate to a human.
          this.store.setStatusCleared(task.id, 'review');
          this.store.appendEvent(task.id, null, 'review_escalated', {
            reason: `review could not be spawned after ${failures} attempt(s)`
          });
        } else {
          this.store.setStatusCleared(task.id, 'review'); // retry next tick
        }
        log.error('review spawn failed', { taskId: task.id, error: msg });
      }
    }
  }

  /**
   * For each freshly-done spec stage: with ≥1 implement child, create an approve_spec
   * proposal targeting the gate task (PM-agent-independent — created at the store level).
   * With zero children, block the spec ("architect produced no implementation tasks") and
   * raise NO proposal. Idempotent via a one-shot 'spec_approval_raised' event.
   */
  private raiseSpecApprovals(): void {
    for (const spec of this.store.doneSpecTasks()) {
      if (this.store.listEvents(spec.id).some((e) => e.kind === 'spec_approval_raised')) continue;
      const gateId = this.store
        .childrenOf(spec.id)
        .find((id) => this.store.getTask(id)?.pipelineStage === 'gate');
      if (!gateId) {
        log.warn('raiseSpecApprovals: spec has no gate child; skipping', { specId: spec.id });
        continue;
      }
      const children = this.store
        .childrenOf(gateId)
        .filter((id) => this.store.getTask(id)?.pipelineStage === 'implement');
      if (children.length === 0) {
        this.store.blockTask(spec.id, 'architect produced no implementation tasks');
        this.store.appendEvent(spec.id, null, 'spec_approval_raised', { empty: true });
        continue;
      }
      const rationale =
        `Architect plan: ${spec.result ?? spec.title}. ` +
        `${children.length} implementation task(s). Review explore findings before approving.`;
      this.store.createProposal({
        boardId: spec.boardId,
        kind: 'approve_spec',
        targetId: gateId,
        rationale
      });
      this.store.appendEvent(spec.id, null, 'spec_approval_raised', {
        gateId,
        children: children.length
      });
    }
  }

  /**
   * Handle QA request_changes: re-arm the feature's implement children for a fix run, once
   * per qa_changes_requested event, bounded by QA_ATTEMPT_CAP. On cap exhaustion mark the
   * qa task blocked and emit a 'blocked' event (the #233 autopilot trigger surfaces it).
   */
  private processQaChanges(): void {
    for (const qa of this.store.qaTasksNeedingRearm()) {
      if (!qa.featureId) continue;
      const attempts = this.store.listEvents(qa.id).filter((e) => e.kind === 'qa_rearmed').length;
      if (attempts >= QA_ATTEMPT_CAP) {
        this.store.blockTask(qa.id, `QA still failing after ${QA_ATTEMPT_CAP} attempt(s)`);
        this.store.appendEvent(qa.id, null, 'blocked', { reason: 'qa_attempt_cap' });
        continue;
      }
      // Re-arm implement children: set them back to ready with the QA findings as guidance.
      for (const childId of this.store.implementChildrenOf(qa.id)) {
        this.store.setStatus(childId, 'ready');
      }
      this.store.setQaVerdict(qa.featureId, null); // clear so the next QA run can re-verdict
      this.store.setStatus(qa.id, 'todo'); // qa re-gates on the children again
      this.store.appendEvent(qa.id, null, 'qa_rearmed', { attempt: attempts + 1 });
    }
  }

  /** Auto-integrate completed feature tasks and sync completed features. Local git only — no push/PR (that is #229). */
  integrate(): void {
    if (!this.deps.config.autoIntegrate) return;
    const budget = this.integrateTasks(MAX_INTEGRATE_PER_TICK);
    this.integrateFeatures(budget);
  }

  /** Merge each review feature task into its integration branch; spawn a resolve run on conflict. Returns remaining budget. */
  private integrateTasks(budget: number): number {
    for (const task of this.store.reviewWorktreeFeatureTasks()) {
      if (budget <= 0) break;
      if (!task.repoPath || !task.branchName || !task.baseBranch || !task.workspacePath) continue;

      // Agent review gate (#232): a reviewed task merges only on an 'approve' verdict,
      // and only at the exact HEAD that was approved (a later run may have changed the tree).
      if (this.deps.config.autoReview) {
        if (task.reviewVerdict !== 'approve') continue;
        const head = task.workspacePath ? this.ops.headSha(task.workspacePath) : null;
        if (head != null && task.reviewHeadSha != null && head !== task.reviewHeadSha) {
          this.store.clearReviewVerdict(task.id); // drifted → re-review next tick
          this.store.appendEvent(task.id, null, 'review_stale', {
            approved: task.reviewHeadSha,
            head
          });
          continue;
        }
      }

      const integrationBranch = this.integrationBranchFor(task.featureId);
      if (!integrationBranch) continue;

      const ensured = this.ops.ensureFeatureBranch({
        repoPath: task.repoPath,
        integrationBranch,
        baseBranch: task.baseBranch
      });
      if (!ensured.ok) {
        this.store.appendEvent(task.id, null, 'merge_failed', {
          base: integrationBranch,
          error: ensured.error
        });
        continue;
      }

      const pred = this.ops.checkMergeConflicts({
        repoPath: task.repoPath,
        baseBranch: integrationBranch,
        branchName: task.branchName
      });
      if (pred.state === 'error') continue; // can't predict — leave in review for a human
      if (pred.state === 'conflicts') {
        if (this.spawnResolve(task, integrationBranch)) budget -= 1;
        continue;
      }
      // clean prediction → real merge into the (local) integration branch
      const res = this.ops.mergeWorktreeToBase({
        repoPath: task.repoPath,
        branchName: task.branchName,
        baseBranch: integrationBranch,
        worktreeParentDir: dirname(task.workspacePath),
        taskId: task.id,
        title: task.title
      });
      if (res.ok) {
        this.store.completeTask(task.id, task.result);
        this.store.appendEvent(task.id, null, 'merged', {
          base: integrationBranch,
          branch: task.branchName,
          by: 'integrate'
        });
        this.ops.removeWorktree({
          repoPath: task.repoPath,
          workspacePath: task.workspacePath,
          branchName: task.branchName,
          baseBranch: integrationBranch
        });
        this.store.setWorktreePruned(task.id);
        this.store.appendEvent(task.id, null, 'worktree_pruned', {
          branch: task.branchName,
          by: 'integrate'
        });
        this.store.resetResolveAttempts(task.id);
        this.ensureFeaturePr(task.featureId);
        budget -= 1;
      } else if (res.conflict) {
        if (this.spawnResolve(task, integrationBranch)) budget -= 1; // prediction raced (clean→dirty)
      } else {
        this.store.appendEvent(task.id, null, 'merge_failed', {
          base: integrationBranch,
          error: res.error
        });
      }
    }
    return budget;
  }

  /**
   * Publish a feature as one PR after a member task merges: first merge opens a
   * draft PR (push + `gh pr create --draft`); later merges push only (the PR
   * self-updates). No remote / no gh -> one deduped `feature_pr_skipped` event,
   * never retried. All best-effort: failures append an event, never throw.
   */
  private ensureFeaturePr(featureId: string | null): void {
    if (!featureId) return;
    const f = this.store.getFeature(featureId);
    if (!f || !f.repoPath || !f.baseBranch) return;
    const integrationBranch = this.integrationBranchFor(featureId);
    if (!integrationBranch) return;

    if (f.prNumber != null) {
      const r = this.ops.pushIntegrationBranch({ repoPath: f.repoPath, integrationBranch });
      if (!r.ok) this.store.appendEvent(featureId, null, 'feature_push_failed', { error: r.error });
      return;
    }
    if (f.prSkipNotified) return; // already gave up on remote for this feature

    const r = this.ops.createFeaturePr({
      repoPath: f.repoPath,
      integrationBranch,
      baseBranch: f.baseBranch,
      title: f.name,
      body: `Auto-opened draft PR for feature "${f.name}".`,
      draft: true
    });
    if (r.ok && r.url) {
      this.store.setFeaturePr(featureId, r.url, r.number ?? null, 'draft');
      this.store.appendEvent(featureId, null, 'feature_pr_created', {
        url: r.url,
        number: r.number,
        draft: true
      });
    } else if (r.noRemote || r.noGh) {
      this.store.setFeaturePrSkipNotified(featureId);
      this.store.appendEvent(featureId, null, 'feature_pr_skipped', { reason: r.error });
    }
    // transient error: no flag, no event -> retried on the next merge
  }

  /**
   * Flip a feature's draft PR to ready once the feature is fully done and its
   * integration branch is cleanly synced with main. Best-effort: a failure
   * appends an event and leaves the draft for the manual Ship override.
   */
  private markFeaturePrReady(feature: Feature): void {
    if (feature.prState !== 'draft' || feature.prNumber == null || !feature.repoPath) return;
    // Pipeline features gate PR-ready on a passing QA verdict. A feature that has been
    // QA'd (verdict non-null) but not passed must wait; non-pipeline features (verdict
    // null AND no qa task) are unaffected.
    if (feature.qaVerdict !== null && feature.qaVerdict !== 'pass') return;
    if (feature.qaVerdict === null && this.store.featureHasQaStage(feature.id)) return;
    const r = this.ops.markPrReady({ repoPath: feature.repoPath, prNumber: feature.prNumber });
    if (r.ok) {
      this.store.setFeaturePrState(feature.id, 'open');
      this.store.appendEvent(feature.id, null, 'feature_pr_ready', { number: feature.prNumber });
    } else {
      this.store.appendEvent(feature.id, null, 'feature_pr_ready_failed', {
        number: feature.prNumber,
        error: r.error
      });
    }
  }

  /** Sync each fully-done feature's integration branch with main; spawn a feature_sync resolve task on conflict. */
  private integrateFeatures(budget: number): void {
    for (const feature of this.store.listFeatures({ status: 'active' })) {
      if (budget <= 0) break;
      if (!feature.repoPath || !feature.baseBranch) continue;
      const integrationBranch = feature.integrationBranch ?? `fleet/feature-${feature.id}`;

      const rollup = this.store.featureRollup(feature.id); // system tasks already excluded
      const allDone = rollup.total > 0 && rollup.done + rollup.archived === rollup.total;
      if (!allDone) continue;

      // Only act once integration actually contains merged work (branch ahead of base).
      if (
        this.ops.isBranchMerged({
          repoPath: feature.repoPath,
          branchName: integrationBranch,
          baseBranch: feature.baseBranch
        })
      ) {
        continue;
      }

      const open = this.store.openSystemTask(feature.id, 'feature_sync');
      if (open?.status === 'running') continue; // a resolve is already in flight

      if (open?.status === 'review') {
        // The resolve worker finished. Did it actually merge base into the integration branch?
        // (synced check: base is now an ancestor of the integration branch).
        const synced = this.ops.isBranchMerged({
          repoPath: feature.repoPath,
          branchName: feature.baseBranch,
          baseBranch: integrationBranch
        });
        if (synced) {
          // Free the integration branch (prune the worktree; the branch is ahead of base so it's kept), close the task.
          if (open.workspacePath && open.branchName) {
            this.ops.removeWorktree({
              repoPath: feature.repoPath,
              workspacePath: open.workspacePath,
              branchName: open.branchName,
              baseBranch: feature.baseBranch
            });
          }
          this.store.setWorktreePruned(open.id);
          this.store.completeTask(open.id, 'synced with main');
          this.store.appendEvent(open.id, null, 'merged', {
            base: feature.baseBranch,
            by: 'feature_sync'
          });
          this.store.updateFeature(feature.id, { mergeState: 'in_progress' });
          this.markFeaturePrReady(feature);
        } else {
          // completed without resolving — retry (cap enforced in spawnResolve, then it blocks)
          if (this.spawnResolve(open, feature.baseBranch)) budget -= 1;
        }
        continue;
      }

      // No open system task:
      if (feature.mergeState === 'in_progress' || feature.mergeState === 'merged') continue; // fire-once

      const sync = this.ops.updateIntegrationBranchFromMain({
        repoPath: feature.repoPath,
        integrationBranch,
        baseBranch: feature.baseBranch
      });
      if (sync.ok) {
        this.store.updateFeature(feature.id, { mergeState: 'in_progress' });
        this.markFeaturePrReady(feature);
        budget -= 1; // a sync is a real git op — count it against the tick budget
      } else if (sync.conflict) {
        this.store.updateFeature(feature.id, { mergeState: 'conflict' });
        const sys = this.createFeatureSyncTask(feature, integrationBranch);
        if (sys && this.spawnResolve(sys, feature.baseBranch)) budget -= 1;
      }
      // sync error (e.g. base not found): leave for next tick
    }
  }

  /**
   * Create the synthetic system task whose worktree checks out the integration branch itself,
   * so a resolve run can merge main into it. Excluded from feature roll-ups via system_kind.
   */
  private createFeatureSyncTask(feature: Feature, integrationBranch: string): Task | null {
    if (!feature.repoPath || !feature.baseBranch) return null;
    const task = this.store.createTask({
      title: `Sync ${feature.name} with main`,
      body: `Merge ${feature.baseBranch} into ${integrationBranch} and resolve any conflicts so the feature can ship.`,
      status: 'review', // spawnResolve claims from review
      boardId: feature.boardId,
      featureId: feature.id,
      systemKind: 'feature_sync',
      workspaceKind: 'worktree',
      repoPath: feature.repoPath,
      branchName: integrationBranch, // the worktree checks out the integration branch
      baseBranch: feature.baseBranch
    });
    this.store.appendEvent(task.id, null, 'task_created', {
      by: 'dispatcher',
      system: 'feature_sync'
    });
    return task;
  }

  /**
   * Flag pipelines stalled at their current stage past PIPELINE_STALE_MS (gate never
   * approved, QA looping, dead stage). There is no 'blocked' feature status, so the signal
   * is a feature-level 'blocked' event (reason 'pipeline_stalled') that the #233 autopilot
   * trigger surfaces — the same channel processQaChanges/reclaim emit blocks on. Fire-once
   * per feature: a prior 'pipeline_stalled' event short-circuits the re-emit.
   */
  sweepStalePipelines(): void {
    const cutoff = this.deps.now() - PIPELINE_STALE_MS;
    for (const f of this.store.activePipelineFeatures()) {
      const tasks = this.store.pipelineTasksForFeature(f.id);
      if (tasks.length === 0) continue;
      const live = tasks.some((t) => t.status === 'running' || t.status === 'ready');
      if (live) continue;
      const settled = tasks.every((t) => t.status === 'done' || t.status === 'archived');
      if (settled) continue; // pipeline finished, not stalled
      const lastUpdate = Math.max(...tasks.map((t) => t.updatedAt));
      if (lastUpdate > cutoff) continue; // still within the idle window
      // Fire-once: skip if we already flagged this feature as stalled.
      const alreadyFlagged = this.store
        .listEvents(f.id)
        .some((e) => e.kind === 'blocked' && e.payload?.reason === 'pipeline_stalled');
      if (alreadyFlagged) continue;
      this.store.appendEvent(f.id, null, 'blocked', { reason: 'pipeline_stalled' });
      log.warn('pipeline stalled', { featureId: f.id, lastUpdate });
    }
  }

  /** Purge discarded artifacts past the retention window; surface each deletion as an event. */
  sweepArtifacts(): void {
    const days = this.deps.config.artifactRetentionDays;
    if (!days || days <= 0) return; // 0 (or unset) disables auto-purge
    const cutoff = this.deps.now() - days * 86_400_000;
    for (const a of this.store.purgeDiscardedBefore(cutoff)) {
      this.store.appendEvent(a.taskId, a.runId, 'artifact_purged', {
        id: a.id,
        filename: a.filename
      });
    }
  }

  /**
   * Reclaim disk from finished worktrees whose branch is already merged into its base
   * (a safety net behind merge-time auto-prune — catches tasks merged out-of-band).
   * Only ever removes provably-merged worktrees, so no unmerged work is destroyed.
   *
   * Throttled to once every WORKTREE_SWEEP_INTERVAL_MS: each candidate costs a git
   * subprocess, and the unmerged candidates (PR'd / accepted-as-is) never clear, so
   * running it every 5s tick would re-scan them forever and stall claiming.
   */
  sweepMergedWorktrees(): void {
    const now = this.deps.now();
    if (now - this.lastWorktreeSweepAt < WORKTREE_SWEEP_INTERVAL_MS) return;
    this.lastWorktreeSweepAt = now;
    for (const task of this.store.worktreeTasks({ statuses: ['done', 'archived'] })) {
      if (!task.workspacePath || !task.repoPath || !task.branchName || !task.baseBranch) continue;
      if (
        !isBranchMerged({
          repoPath: task.repoPath,
          branchName: task.branchName,
          baseBranch: task.baseBranch
        })
      ) {
        continue;
      }
      removeWorktree({
        repoPath: task.repoPath,
        workspacePath: task.workspacePath,
        branchName: task.branchName,
        baseBranch: task.baseBranch
      });
      this.store.setWorktreePruned(task.id);
      this.store.appendEvent(task.id, null, 'worktree_pruned', {
        branch: task.branchName,
        by: 'sweep'
      });
    }
  }

  tick(): void {
    this.reclaim();
    this.fireSchedules();
    this.decompose();
    this.autoAssign();
    this.detectFeatureGroups();
    this.promote();
    this.claimAndSpawn();
    this.reviewTasks();
    this.raiseSpecApprovals();
    this.processQaChanges();
    this.integrate();
    this.sweepArtifacts();
    this.sweepMergedWorktrees();
    this.sweepStalePipelines();
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.error('tick error', { error: err instanceof Error ? err.message : String(err) });
      }
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Apply new config + interval. Per-tick reads pick up `config` immediately;
   * the interval is only read in start(), so restart the timer if it changed.
   */
  reconfigure(config: DispatcherConfig, intervalMs: number): void {
    const intervalChanged = intervalMs !== (this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.deps.config = config;
    this.deps.intervalMs = intervalMs;
    if (this.timer && intervalChanged) {
      this.stop();
      this.start();
    }
  }
}
