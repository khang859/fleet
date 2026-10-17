import { randomUUID } from 'node:crypto';
import {
  jobDisplayId,
  type AdmiralClaimResult,
  type AdmiralThreadScope,
  type AgencyAnswerRequest,
  type AgencyChanged,
  type AgencyJob,
  type AgencyPreflight,
  type AgencyQuestion,
  type AgencyRepoRef,
  type AgencySnapshot,
  type RepoResolution,
  type WakeupPull,
  type WakeupRelease
} from '../../shared/agency';
import { createLogger } from '../logger';
import { AdmiralRegistry } from './admiral-registry';
import { runPreflight, type Probe } from './preflight';
import { resolveRepoIdentity, type RepoIdentityOptions } from './repo-identity';
import { agencyDbPath } from './store/agency-db';
import { AgencyStore, type AgencyTouched, type AskQuestionInput } from './store/agency-store';

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

  /**
   * The conversation an Admiral turn says it is, checked against the records:
   * the repository is known, the job is that repository's, and the turn's
   * thread is that job's (or the lobby's) own session. A turn that fails this
   * does not run, so no tool can write in another job's name.
   */
  threadScope(input: AdmiralThreadScope & { threadId: string }): AdmiralThreadScope {
    const repo = this.store.repo(input.repoId);
    if (repo === null) {
      throw new Error(
        'Fleet has no record of the repository this Admiral is for. Close the pane and open the Admiral again.'
      );
    }
    if (input.jobId === null) {
      if (this.store.lobbySessionId(repo.repoId) !== input.threadId) {
        throw new Error(`This conversation is not the lobby of ${repo.name}.`);
      }
      return { repoId: repo.repoId, jobId: null };
    }
    const id = jobDisplayId(input.jobId);
    const job = this.store.getJob(input.jobId);
    if (job?.repoId !== repo.repoId) throw new Error(`${id} is not a job in ${repo.name}.`);
    if (job.sessionId !== input.threadId) throw new Error(`This conversation is not ${id}'s.`);
    return { repoId: repo.repoId, jobId: job.id };
  }

  /** Put a question to the client in `scope`'s name. */
  ask(
    scope: AdmiralThreadScope,
    input: Omit<AskQuestionInput, 'repoId' | 'jobId' | 'kind'>
  ): AgencyQuestion {
    const question = this.store.askQuestion({ ...input, ...scope });
    this.changed([scope]);
    return question;
  }

  /**
   * Open a job from a repository's lobby, with a session of its own. The
   * change names it as opened, which is what starts the renderer's handoff.
   */
  openJob(input: {
    repoId: string;
    title: string;
    brief: string;
    budgetUsd: number | null;
  }): AgencyJob {
    const job = this.store.openJob({ ...input, sessionId: randomUUID() });
    this.deps.emit({ repoId: job.repoId, jobIds: [job.id], openedJobId: job.id });
    return job;
  }

  /**
   * The panes of a job's crew, which are all its fleet read tools may see.
   * Empty for every thread until crew can be hired; that phase takes the
   * thread's scope here and answers from the job's hires.
   */
  crewPanes(): ReadonlySet<string> {
    return new Set();
  }

  /** Whether an agent session is an Admiral lobby's or job's, for its session header. */
  isAdmiralSession(sessionId: string): boolean {
    return this.store.isAdmiralSession(sessionId);
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
