import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task, RunMode } from '../../shared/kanban-types';

const log = createLogger('kanban-dispatcher');

const DEFAULT_INTERVAL_MS = 5000;

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
  maxDecompose: number; // max concurrent orchestrator runs
}

export interface DispatcherDeps {
  now: () => number;
  isAlive: (pid: number) => boolean;
  spawnWorker: (args: SpawnWorkerArgs) => number | undefined; // returns pid
  config: DispatcherConfig;
  prepareWorkspaceFn?: (task: Task) => string;
  intervalMs?: number;
}

export class KanbanDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private genLock = 0;

  constructor(
    private store: KanbanStore,
    private deps: DispatcherDeps
  ) {}

  /** Return expired/dead running tasks to ready, or give up past the failure limit. */
  reclaim(): void {
    const now = this.deps.now();
    for (const task of this.store.runningTasks()) {
      const expired = task.claimExpires != null && task.claimExpires <= now;
      const fresh =
        task.lastHeartbeatAt != null && now - task.lastHeartbeatAt < this.deps.config.claimGraceMs;
      const dead = task.workerPid != null && !fresh && !this.deps.isAlive(task.workerPid);
      if (!expired && !dead) continue;

      const reason = expired ? 'claim expired' : 'worker pid not alive';
      if (task.currentRunId != null) {
        this.store.finishRun(task.currentRunId, 'reclaimed', { error: reason });
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
        if (mode && mode !== 'work') this.store.setStatusCleared(task.id, 'triage');
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
        log.error('decompose spawn failed', { taskId: task.id, error: msg });
      }
    }
  }

  tick(): void {
    this.reclaim();
    this.decompose();
    this.promote();
    this.claimAndSpawn();
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
