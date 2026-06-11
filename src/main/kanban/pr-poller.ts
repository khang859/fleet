import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task } from '../../shared/kanban-types';
import { fetchPrState } from './workspace';

const log = createLogger('kanban-pr-poller');

const DEFAULT_INTERVAL_MS = 60_000; // how often a sweep runs
const MIN_SYNC_GAP_MS = 45_000; // don't re-poll a single PR more often than this
const BATCH = 20; // PRs polled per sweep (serial, to stay gentle on the gh API)
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000; // pause all polling this long after a rate-limit hit
const FEATURE_BATCH = 10; // feature PRs polled per sweep (serial, alongside task PRs)

export interface PrPollerDeps {
  now: () => number;
  intervalMs?: number;
  /** Injected for tests; defaults to the real `gh` lookup. */
  fetchPrState?: typeof fetchPrState;
}

/**
 * Polls open/draft PR status from `gh` on its own interval — deliberately NOT
 * inside the dispatcher tick, where a ~300ms–1s network call would stall task
 * claiming. Informational only: it never changes a task's status (Make PR
 * already marked it done), only its PR badge fields. Writes are made via
 * `setPrStatus`, which bumps `pr_synced_at` so the next sweep skips just-polled
 * PRs; an event is emitted only when something actually changed, so the board
 * refreshes without churning on every no-op poll.
 */
export class PrPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private rateLimitedUntil = 0;
  private readonly fetch: typeof fetchPrState;

  constructor(
    private store: KanbanStore,
    private deps: PrPollerDeps
  ) {
    this.fetch = deps.fetchPrState ?? fetchPrState;
  }

  /** One sweep: poll up to BATCH due PRs serially, writing back any changes. */
  sweep(): void {
    const now = this.deps.now();
    if (now < this.rateLimitedUntil) return;
    const due = this.store.tasksDuePrSync(now - MIN_SYNC_GAP_MS, BATCH);
    for (const task of due) {
      const ref = task.prInfo?.number != null ? String(task.prInfo.number) : null;
      const cwd = task.workspacePath ?? task.repoPath;
      if (!ref || !cwd) continue; // can't poll without a PR number + a repo dir
      const res = this.fetch({ workspacePath: cwd, prRef: ref });
      if (!res.ok) {
        if (res.noGh) return; // gh missing — no point continuing this sweep
        if (res.rateLimited) {
          this.rateLimitedUntil = this.deps.now() + RATE_LIMIT_BACKOFF_MS;
          log.warn('gh rate limit hit; backing off PR polling', { taskId: task.id });
          return;
        }
        if (res.notFound) {
          // The PR was deleted/branch gone upstream: clear state so it stops being polled.
          this.store.setPrStatus(task.id, {
            prState: null,
            checksState: null,
            prMergeState: null
          });
          this.store.appendEvent(task.id, null, 'pr_synced', { state: null });
        }
        // Other errors are transient — leave pr_synced_at untouched so we retry next sweep.
        continue;
      }
      this.writeBack(task, res);
    }
    this.sweepFeatures(now);
  }

  /** Poll active feature PRs by number, writing back prState/checksState (mirrors the task loop). */
  private sweepFeatures(now: number): void {
    // Defensive: sweep() already guards on rateLimitedUntil before calling here;
    // kept so a future refactor that calls sweepFeatures independently stays safe.
    if (now < this.rateLimitedUntil) return;
    const due = this.store.featuresDuePrSync(now - MIN_SYNC_GAP_MS, FEATURE_BATCH);
    for (const feature of due) {
      const ref = feature.prNumber != null ? String(feature.prNumber) : null;
      const cwd = feature.repoPath;
      if (!ref || !cwd) continue; // can't poll without a PR number + a repo dir
      const res = this.fetch({ workspacePath: cwd, prRef: ref });
      if (!res.ok) {
        if (res.noGh) return; // gh missing — no point continuing this sweep
        if (res.rateLimited) {
          this.rateLimitedUntil = this.deps.now() + RATE_LIMIT_BACKOFF_MS;
          log.warn('gh rate limit hit; backing off PR polling', { featureId: feature.id });
          return;
        }
        if (res.notFound) {
          // The PR was deleted/branch gone upstream: clear state so it stops being polled.
          this.store.setFeaturePrStatus(feature.id, { prState: null, checksState: null });
          this.store.appendEvent(feature.id, null, 'feature_pr_synced', { state: null });
        }
        // Other errors are transient — leave pr_synced_at untouched so we retry next sweep.
        continue;
      }
      const changed = feature.prState !== res.state || feature.checksState !== res.checksState;
      this.store.setFeaturePrStatus(feature.id, {
        prState: res.state,
        checksState: res.checksState
      });
      if (changed) {
        this.store.appendEvent(feature.id, null, 'feature_pr_synced', {
          state: res.state,
          checks: res.checksState
        });
      }
    }
  }

  private writeBack(task: Task, res: Extract<ReturnType<typeof fetchPrState>, { ok: true }>): void {
    const prev = task.prInfo;
    const changed =
      !prev ||
      prev.state !== res.state ||
      prev.checksState !== res.checksState ||
      prev.mergeState !== res.mergeState;
    this.store.setPrStatus(task.id, {
      prState: res.state,
      checksState: res.checksState,
      prMergeState: res.mergeState,
      prNumber: res.number || undefined
    });
    if (changed) {
      this.store.appendEvent(task.id, null, 'pr_synced', {
        state: res.state,
        checks: res.checksState
      });
    }
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        log.error('pr poll sweep error', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
