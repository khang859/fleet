import type {
  AdmiralClaimResult,
  AgencyAnswerRequest,
  AgencyChanged,
  AgencyJob,
  AgencyPreflight,
  AgencyQuestion,
  AgencyRepoRef,
  AgencySnapshot,
  RepoResolution,
  WakeupPull,
  WakeupRelease
} from '../../shared/agency';
import { createLogger } from '../logger';
import { AdmiralRegistry } from './admiral-registry';
import { runPreflight, type Probe } from './preflight';
import { resolveRepoIdentity, type RepoIdentityOptions } from './repo-identity';
import { agencyDbPath } from './store/agency-db';
import { AgencyStore, type AgencyTouched } from './store/agency-store';

const log = createLogger('agency');

export type AgencyServiceDeps = {
  /** Defaults to `~/.fleet/agency.db`. */
  dbPath?: string;
  /** Tell the renderer a repository's agency state changed. */
  emit: (change: AgencyChanged) => void;
  /** Whether the Admiral has a model to run on: an OpenRouter key or a local endpoint. */
  hasModelKey: () => boolean;
  now?: () => number;
  probe?: Probe;
  repoIdentity?: Pick<RepoIdentityOptions, 'git' | 'realpath'>;
};

/**
 * The agency's main-process side: the store, the one-per-repo registry, and
 * the operations the renderer reaches through IPC. Every write that changes
 * what an Admiral pane shows raises a change event for its repository.
 */
export class AgencyService {
  readonly store: AgencyStore;
  readonly registry = new AdmiralRegistry();

  constructor(private readonly deps: AgencyServiceDeps) {
    this.store = new AgencyStore(deps.dbPath ?? agencyDbPath(), { now: deps.now });
    // No turn from before this start is still running, so every claim made
    // then is stale, and its wakeups are due again.
    const released = this.store.releaseStaleClaims(0);
    if (released > 0) log.info('released wakeup claims left from the last run', { released });
  }

  async resolveRepo(
    cwd: string,
    opts: Omit<RepoIdentityOptions, 'git' | 'realpath'> = {}
  ): Promise<RepoResolution> {
    return resolveRepoIdentity(cwd, { ...opts, ...this.deps.repoIdentity });
  }

  claim(input: { repoId: string; paneId: string }, owner: number): AdmiralClaimResult {
    return this.registry.claim(input, owner);
  }

  release(paneId: string): void {
    this.registry.release(paneId);
  }

  releaseOwner(owner: number): void {
    this.registry.releaseOwner(owner);
  }

  ensureLobby(repo: AgencyRepoRef): string {
    return this.store.ensureLobby(repo);
  }

  snapshot(repoId: string): AgencySnapshot {
    return this.store.snapshot(repoId);
  }

  answer(req: AgencyAnswerRequest): AgencyQuestion | null {
    const outcome = this.store.answerQuestion(req);
    if (!outcome) return null;
    this.changed([{ repoId: outcome.question.repoId, jobId: outcome.question.jobId }]);
    return outcome.question;
  }

  pullWakeups(input: { repoId: string; jobId: number | null }): WakeupPull {
    return this.store.pullWakeups(input);
  }

  ackWakeups(ids: number[]): void {
    this.changed(this.store.ackWakeups(ids));
  }

  releaseWakeups(input: { ids: number[]; error: string }): WakeupRelease {
    const { nextDueAt, gaveUp, touched } = this.store.releaseWakeups(input);
    if (gaveUp) log.warn('Admiral turn keeps failing; told the client', { error: input.error });
    this.changed(touched);
    return { nextDueAt, gaveUp };
  }

  retryNow(repoId: string): void {
    this.store.retryNow(repoId);
    this.changed([{ repoId, jobId: null }]);
  }

  cancelJobs(repoId: string): number[] {
    const ids = this.store.cancelJobs(repoId);
    if (ids.length > 0) this.changed(ids.map((jobId) => ({ repoId, jobId })));
    return ids;
  }

  markHandoff(input: { jobId: number; lobbyMessageId: string }): boolean {
    const job = this.store.markHandoff(input);
    if (job) this.changed([{ repoId: job.repoId, jobId: job.id }]);
    return job !== null;
  }

  /** Jobs with work under way in any repository, for the quit guard. */
  listRunning(): AgencyJob[] {
    return this.store.listRunning();
  }

  async preflight(): Promise<AgencyPreflight> {
    return runPreflight({ hasModelKey: this.deps.hasModelKey, probe: this.deps.probe });
  }

  close(): void {
    this.store.close();
  }

  /** One change event per repository, naming every job touched in it. */
  private changed(touched: AgencyTouched[]): void {
    const byRepo = new Map<string, Array<number | null>>();
    for (const t of touched) {
      const jobs = byRepo.get(t.repoId) ?? [];
      if (!jobs.includes(t.jobId)) jobs.push(t.jobId);
      byRepo.set(t.repoId, jobs);
    }
    for (const [repoId, jobIds] of byRepo) this.deps.emit({ repoId, jobIds });
  }
}

export function createAgencyService(deps: AgencyServiceDeps): AgencyService {
  return new AgencyService(deps);
}
