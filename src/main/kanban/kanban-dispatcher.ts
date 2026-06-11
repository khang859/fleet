import { dirname } from 'path';
import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task, RunMode, Feature } from '../../shared/kanban-types';
import { computeNextRun, taskToScheduleInput } from './schedule';
import {
  ensureFeatureBranch,
  checkMergeConflicts,
  finalizeWorktree,
  isBranchMerged,
  mergeWorktreeToBase,
  removeWorktree,
  updateIntegrationBranchFromMain
} from './workspace';

const log = createLogger('kanban-dispatcher');

const DEFAULT_INTERVAL_MS = 5000;

/** Minimum gap between merged-worktree prune sweeps (a periodic safety net, not the fast path). */
const WORKTREE_SWEEP_INTERVAL_MS = 300_000;

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
/** Max task merges + resolve spawns processed per integrate() tick, so the tick stays fast. */
const MAX_INTEGRATE_PER_TICK = 3;

/** Git ops used by integrate(); injectable so the stage is unit-testable. Defaults to the real workspace.ts fns. */
export interface IntegrationOps {
  ensureFeatureBranch: typeof ensureFeatureBranch;
  checkMergeConflicts: typeof checkMergeConflicts;
  mergeWorktreeToBase: typeof mergeWorktreeToBase;
  updateIntegrationBranchFromMain: typeof updateIntegrationBranchFromMain;
  removeWorktree: typeof removeWorktree;
  isBranchMerged: typeof isBranchMerged;
}

const DEFAULT_INTEGRATION_OPS: IntegrationOps = {
  ensureFeatureBranch,
  checkMergeConflicts,
  mergeWorktreeToBase,
  updateIntegrationBranchFromMain,
  removeWorktree,
  isBranchMerged
};

export interface SpawnWorkerArgs {
  task: Task;
  runId: number;
  lock: string;
  workspace: string;
  mode: RunMode;
}

export interface DispatcherConfig {
  failureLimit: number; // consecutive failures before gave_up
  claimGraceMs: number; // protect freshly-spawned workers from reclaim
  maxInProgress: number; // concurrency cap
  claimTtlMs: number; // claim lease length
  autoDecompose: boolean; // automatically arm triage tasks for decompose
  autoAssign: boolean; // automatically assign unassigned ready tasks to a worker profile
  autoIntegrate: boolean; // auto-merge feature review tasks into the integration branch + resolve runs
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
  /** Worker-role profile names (in profile order), for the auto-assign fast path and fallback. */
  workerProfileNames?: () => string[];
  /** Git ops for integrate(); injected in tests, defaults to real workspace.ts fns. */
  integration?: IntegrationOps;
}

export class KanbanDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private genLock = 0;
  private lastWorktreeSweepAt = 0;

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
        // assign is also a non-work orchestrator mode — this branch MUST stay before the
        // generic non-work branch below, or a dead assign run would wrongly route to triage.
        if (mode === 'assign') this.store.returnToReady(task.id);
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

  claimAndSpawn(): void {
    const cap = this.deps.config.maxInProgress;
    const ttl = this.deps.config.claimTtlMs;
    let slots = cap - this.store.runningTasks().length;
    if (slots <= 0) return;

    for (const task of this.store.readyTasks()) {
      if (slots <= 0) break;
      const lock = this.nextLock();
      if (!this.store.claimTask(task.id, lock, ttl)) continue; // lost the race

      let pid: number | undefined;
      let runId: number | null = null;
      try {
        const workspace = this.deps.prepareWorkspaceFn
          ? this.deps.prepareWorkspaceFn(task)
          : (task.workspacePath ?? '');
        const run = this.store.startRun(task.id, task.assignee, null);
        runId = run.id;
        pid = this.deps.spawnWorker({ task, runId: run.id, lock, workspace, mode: 'work' });
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
    const attempts = task.resolveAttempts ?? 0;
    if (attempts >= RESOLVE_ATTEMPT_CAP) {
      const note = `merge conflicts unresolved after ${RESOLVE_ATTEMPT_CAP} resolve attempt(s)`;
      this.store.blockTask(task.id, note);
      this.store.appendEvent(task.id, null, 'blocked', { reason: note });
      log.warn('resolve gave up', { taskId: task.id, attempts });
      return false;
    }
    const lock = this.nextLock();
    if (!this.store.claimForResolve(task.id, lock, this.deps.config.claimTtlMs)) return false; // lost race
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
    this.promote();
    this.claimAndSpawn();
    this.integrate();
    this.sweepArtifacts();
    this.sweepMergedWorktrees();
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
