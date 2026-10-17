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
import type {
  JobControl,
  JobControlResult,
  LeftoverAction,
  ResourceKind
} from '../../shared/agency-jobs';
import { WorktreeService } from '../worktree-service';
import { AdmiralRegistry } from './admiral-registry';
import { defaultCleaners, type WorktreeRemover } from './cleanup/cleaners';
import { CleanupRunner, type ResourceCleaner } from './cleanup/cleanup-runner';
import { JobsService, NO_CREW, type CrewControl } from './jobs';
import { reconcileAtStartup } from './jobs/reconcile';
import { runPreflight, type Probe } from './preflight';
import { nativeGh, type GhRun } from './projects/gh';
import { readOnlyGit } from './projects/repo-reader';
import { gatherPlanFacts } from './plans/plan-facts';
import { ProjectsService } from './projects';
import { resolveRepoIdentity, type GitRun, type RepoIdentityOptions } from './repo-identity';
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
  /** Seams for onboarding: the GitHub CLI and the per-project folder. */
  gh?: GhRun;
  agencyHome?: string;
  /** How crew panes are stopped; nothing is ever hired until the crew phase. */
  crew?: CrewControl;
  /** Read-only git for the pre-approval check. */
  git?: GitRun;
  /** Crew members that may work at once; 4 unless set. */
  crewLimit?: () => number;
  /** Removes a job's worktrees at close, never forced. */
  worktrees?: WorktreeRemover;
  /** Whether Fleet is online, so failed cleanup steps are retried. */
  isOnline?: () => boolean;
  /** Seams for cleanup tests: how a kind of resource is undone. */
  cleaners?: Partial<Record<ResourceKind, ResourceCleaner>>;
};

/**
 * The agency's main-process side: the store, the one-per-repo registry, and
 * the operations the renderer reaches through IPC. Every write that changes
 * what an Admiral pane shows raises a change event for its repository.
 */
export class AgencyService {
  readonly store: AgencyStore;
  readonly registry = new AdmiralRegistry();
  readonly projects: ProjectsService;
  readonly jobs: JobsService;
  readonly cleanup: CleanupRunner;

  constructor(private readonly deps: AgencyServiceDeps) {
    this.store = new AgencyStore(deps.dbPath ?? agencyDbPath(), { now: deps.now });
    this.projects = new ProjectsService({
      store: this.store,
      resolve: async (path) => this.resolveRepo(path),
      emit: deps.emit,
      gh: deps.gh,
      home: deps.agencyHome
    });
    this.jobs = new JobsService({
      store: this.store,
      crew: deps.crew ?? NO_CREW,
      changed: (touched) => this.changed(touched),
      crewLimit: deps.crewLimit,
      planFacts: async ({ job, plan, others, pinned }) => {
        const repo = this.store.repo(job.repoId);
        if (!repo) throw new Error(`The project of ${jobDisplayId(job.id)} is not known.`);
        return gatherPlanFacts(
          { repo, plan, others, pinned },
          { git: deps.git ?? readOnlyGit, gh: deps.gh ?? nativeGh }
        );
      }
    });
    const crew = deps.crew ?? NO_CREW;
    this.cleanup = new CleanupRunner({
      store: this.store,
      cleaners: {
        ...defaultCleaners({
          store: this.store,
          crew,
          git: deps.git ?? readOnlyGit,
          worktrees: deps.worktrees ?? new WorktreeService()
        }),
        ...deps.cleaners
      },
      changed: (touched) => this.changed(touched),
      crewFreed: () => this.jobs.admitQueued(),
      isOnline: deps.isOnline ?? (() => true)
    });
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

  /**
   * A pane gave up its repository. The wakeups it had pulled and not finished
   * go back to the queue now, without counting as a failure: only that pane
   * could have claimed them, and it will never ack them.
   */
  release(paneId: string): void {
    for (const repoId of this.registry.release(paneId)) this.store.unclaimWakeups(repoId);
  }

  /** A window reloaded or closed: the same, for every repository it held. */
  releaseOwner(owner: number): void {
    for (const repoId of this.registry.releaseOwner(owner)) this.store.unclaimWakeups(repoId);
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
    const { kind, jobId } = outcome.question;
    // Cancel on the Resume card closes the job, which cleanup has to run for.
    if (kind === 'resume' && req.option === 1 && jobId !== null) {
      this.closeJob({ jobId, action: 'cancel' });
    }
    if (outcome.question.jobId !== null) this.jobs.refreshClientHold(outcome.question.jobId);
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

  /** Cancel the repository's running jobs, as closing its Admiral with "Cancel jobs" asks. */
  cancelJobs(repoId: string): number[] {
    const ids = this.store.cancelJobs(repoId);
    this.closing(ids);
    if (ids.length > 0) this.changed(ids.map((jobId) => ({ repoId, jobId })));
    return ids;
  }

  /** The client cancels a job, or accepts what it delivered: it closes and cleans up. */
  closeJob(control: JobControl): JobControlResult {
    const event =
      control.action === 'accept' ? { type: 'accepted' as const } : { type: 'cancel' as const };
    const reason =
      control.action === 'accept' ? 'the client accepted the results' : 'cancelled by the client';
    const { job, transition } = this.store.beginClose(control.jobId, event, reason);
    if (!transition.ok)
      return {
        ok: false,
        reason: `${jobDisplayId(control.jobId)} cannot close: ${transition.refused}.`
      };
    this.closing([control.jobId]);
    if (job) this.changed([{ repoId: job.repoId, jobId: job.id }]);
    return { ok: true };
  }

  /** Retry or dismiss a leftover of a job's cleanup. */
  async leftover(action: LeftoverAction): Promise<void> {
    if (action.action === 'dismiss') this.cleanup.dismiss(action.resourceId);
    else await this.cleanup.retry(action.resourceId);
  }

  /**
   * Once at launch, after wiring: finish stops a plan change left half done,
   * interrupt jobs whose crew the restart took, finish every close a quit cut
   * short, and start retrying failed cleanup steps.
   */
  async startup(): Promise<void> {
    await this.jobs.replayStops();
    const touched = await reconcileAtStartup({
      store: this.store,
      crew: this.deps.crew ?? NO_CREW,
      git: this.deps.git ?? readOnlyGit
    });
    if (touched.length > 0) this.changed(touched);
    this.cleanup.startRetrying();
    await this.cleanup.resumeAll();
  }

  /** Jobs that just started closing free their place in line, then clean up. */
  private closing(ids: number[]): void {
    if (ids.length === 0) return;
    this.jobs.admitQueued();
    for (const id of ids) void this.cleanup.start(id);
  }

  /** The client wrote to a job's Admiral: its automatic-turn count starts again. */
  clientActivity(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (!job) return;
    this.store.resetChain(jobId);
    this.changed([{ repoId: job.repoId, jobId }]);
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

  /**
   * Put a question to the client in `scope`'s name. A question about a step
   * must name one in the job's plan, and is tied to that plan version, so a
   * change that drops the step withdraws it.
   */
  ask(
    scope: AdmiralThreadScope,
    input: Omit<AskQuestionInput, 'repoId' | 'jobId' | 'kind' | 'planVersion'>
  ): AgencyQuestion {
    const step = input.step ?? null;
    const plan =
      scope.jobId === null ? { planVersion: null } : this.jobs.questionPlan(scope.jobId, step);
    if (plan.error !== undefined) throw new Error(plan.error);
    const question = this.store.askQuestion({ ...input, ...scope, planVersion: plan.planVersion });
    if (scope.jobId !== null) this.jobs.refreshClientHold(scope.jobId);
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

  /** The project's client file for an Admiral turn's note, or null when there is none. */
  clientFileForNote(repoId: string): string | null {
    return this.projects.clientFileForNote(repoId);
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
    this.cleanup.stopRetrying();
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
