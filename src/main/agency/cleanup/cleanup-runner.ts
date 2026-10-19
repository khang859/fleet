import type { ResourceKind } from '../../../shared/agency-jobs';
import { createLogger } from '../../logger';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import type { ResourceRecord } from '../store/resource-store';
import { joinOnce } from '../join-once';
import { Ticker } from '../ticker';

const log = createLogger('agency-cleanup');

/** What undoing one resource came to. A cleaner that throws has failed. */
export type CleanerResult = { status: 'cleaned' } | { status: 'kept'; reason: string };

export type ResourceCleaner = (resource: ResourceRecord) => Promise<CleanerResult>;

/** Crew first, so nothing writes to a worktree while it goes; the folder they sit in last. */
export const CLEANUP_ORDER: readonly ResourceKind[] = [
  'crew_pane',
  'compose_project',
  'member_worktree',
  'umbrella_worktree',
  'workspace_dir'
];

/** Automatic retries of a failed resource; Retry in Leftovers always runs. */
export const MAX_AUTO_RETRIES = 5;

const RETRY_INTERVAL_MS = 60_000;

export type CleanupDeps = {
  store: AgencyStore;
  cleaners: Record<ResourceKind, ResourceCleaner>;
  changed: (touched: AgencyTouched[]) => void;
  /** Crew places freed up, so a queued step may start. */
  crewFreed: () => void;
  /** A job ended: its cleanup is done and its record is complete. */
  closed?: (jobId: number) => void;
  /** Lines the close summary adds about what the job delivered, like a PR closed unmerged. */
  closeNotes?: (jobId: number) => Promise<string[]>;
  isOnline: () => boolean;
};

/**
 * Ends closing jobs. One idempotent run per job over the resources recorded
 * before they were made: stop the crew, then undo the rest in order, keeping
 * any worktree with work in it. A second close joins the run under way, a run
 * cut short by a quit starts over at the next launch, and what could not be
 * undone stays in Leftovers until it is cleaned or dismissed.
 */
export class CleanupRunner {
  private readonly running = new Map<number, Promise<void>>();
  private readonly retrying = new Map<number, Promise<void>>();
  private readonly ticker = new Ticker();

  constructor(private readonly deps: CleanupDeps) {}

  /** Clean a closing job up and end it. Joins a run already under way. */
  async start(jobId: number): Promise<void> {
    return joinOnce(this.running, jobId, async () => this.run(jobId));
  }

  /** At launch: every job a quit or crash left closing. */
  async resumeAll(): Promise<void> {
    await Promise.all(this.deps.store.jobsIn(['closing']).map(async (job) => this.start(job.id)));
  }

  /** Retry in Leftovers, or a retry once Fleet is back online. */
  async retry(resourceId: number): Promise<void> {
    return joinOnce(this.retrying, resourceId, async () => this.retryOne(resourceId));
  }

  dismiss(resourceId: number): void {
    const resource = this.deps.store.resources.get(resourceId);
    if (resource?.status !== 'kept' && resource?.status !== 'failed') return;
    this.deps.store.resources.settle(resourceId, 'dismissed', resource.detail);
    this.touch(resource.jobId);
  }

  async retryFailedIfOnline(): Promise<void> {
    if (!this.deps.isOnline()) return;
    for (const r of this.deps.store.resources.retryable(MAX_AUTO_RETRIES)) await this.retry(r.id);
  }

  /** Retry failed leftovers every minute while Fleet is online. */
  startRetrying(intervalMs = RETRY_INTERVAL_MS): void {
    this.ticker.start(() => void this.retryFailedIfOnline(), intervalMs);
  }

  stopRetrying(): void {
    this.ticker.stop();
  }

  private async run(jobId: number): Promise<void> {
    const { store } = this.deps;
    if (store.getJob(jobId)?.state !== 'closing') return;
    this.recordCrewPanes(jobId);
    const todo = store.resources
      .forJob(jobId)
      .filter((r) => r.status === 'planned' || r.status === 'live')
      .sort((a, b) => CLEANUP_ORDER.indexOf(a.kind) - CLEANUP_ORDER.indexOf(b.kind));
    for (const resource of todo) await this.clean(resource);
    this.deps.crewFreed();
    const notes = (await this.deps.closeNotes?.(jobId).catch(() => [])) ?? [];
    store.tx(() => {
      store.plans.log({
        jobId,
        kind: 'close_summary',
        text: [closeSummary(store.resources.forJob(jobId)), ...notes].join(' ')
      });
      store.finishClose(jobId, 'cleanup done');
    });
    this.touch(jobId);
    this.deps.closed?.(jobId);
  }

  /**
   * A crew member still live gets a resource row for its pane, so stopping it
   * is undone, retried and listed like everything else. Members with no pane
   * have nothing to stop.
   */
  private recordCrewPanes(jobId: number): void {
    const { store } = this.deps;
    const recorded = new Set(
      store.resources
        .forJob(jobId)
        .filter((r) => r.kind === 'crew_pane')
        .map((r) => r.path)
    );
    store.tx(() => {
      for (const crew of store.crew.live(jobId)) {
        if (crew.paneId === null) store.crew.end(crew.id, 'job closing');
        else if (!recorded.has(crew.paneId)) {
          recorded.add(crew.paneId);
          store.resources.record({
            jobId,
            kind: 'crew_pane',
            label: `${crew.label} pane`,
            path: crew.paneId,
            status: 'live'
          });
        }
      }
    });
  }

  private async clean(resource: ResourceRecord): Promise<void> {
    try {
      const result = await this.deps.cleaners[resource.kind](resource);
      if (result.status === 'cleaned') this.deps.store.resources.settle(resource.id, 'cleaned');
      else this.deps.store.resources.settle(resource.id, 'kept', result.reason);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn('a cleanup step failed', { id: resource.id, kind: resource.kind, error });
      this.deps.store.resources.settle(resource.id, 'failed', error);
    }
  }

  private async retryOne(resourceId: number): Promise<void> {
    const resource = this.deps.store.resources.get(resourceId);
    if (!resource) return;
    // A close under way owns its resources; retry what it left once it ends.
    await this.running.get(resource.jobId);
    const now = this.deps.store.resources.get(resourceId);
    if (now?.status !== 'kept' && now?.status !== 'failed') return;
    await this.clean(now);
    if (now.kind === 'crew_pane') this.deps.crewFreed();
    this.touch(now.jobId);
  }

  private touch(jobId: number): void {
    const job = this.deps.store.getJob(jobId);
    if (job) this.deps.changed([{ repoId: job.repoId, jobId }]);
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const sentence = (text: string): string => `${text.trim().replace(/\.$/, '')}.`;

/** One line on what cleanup did, for the job's record and its sheet. */
export function closeSummary(resources: readonly ResourceRecord[]): string {
  const cleaned = resources.filter((r) => r.status === 'cleaned' && r.kind !== 'crew_pane');
  const kept = resources.filter((r) => r.status === 'kept');
  const failed = resources.filter((r) => r.status === 'failed');
  const lines = [
    cleaned.length > 0 ? `Cleaned up ${plural(cleaned.length, 'workspace')}.` : null,
    ...kept.map((r) => `Kept ${r.label}: ${sentence(r.detail)}`),
    ...failed.map((r) => `Could not clean ${r.label}: ${sentence(r.detail)}`),
    failed.length > 0 ? 'Retry them in Leftovers.' : null
  ].filter((s): s is string => s !== null);
  return lines.length === 0 ? 'Nothing to clean up.' : lines.join(' ');
}
