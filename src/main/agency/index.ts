import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  DEFAULT_AGENCY_SETTINGS,
  TERMINAL_JOB_STATES,
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
  type ClientFileProposal,
  type RepoResolution,
  type WakeupPull,
  type WakeupRelease
} from '../../shared/agency';
import { clientEntries, sameText } from '../../shared/agency-client-file';
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
import { exportJob } from './jobs/job-export';
import { reconcileAtStartup } from './jobs/reconcile';
import { runPreflight, type Probe } from './preflight';
import { ClientFiles, type ClientFileNote } from './projects/client-file';
import { nativeGh, type GhRun } from './projects/gh';
import { agencyHome } from './projects/paths';
import { PrCards } from './results/pr-cards';
import { ResultsService } from './results';
import { readOnlyGit } from './projects/repo-reader';
import { projectMembers } from './projects/workspace-projects';
import { JobWorkspaces, type GitWrite } from './workspaces/job-workspace';
import { pushUmbrellaBump } from './workspaces/umbrella-bump';
import { MergeQueue } from './results/merge-queue';
import { gatherPlanFacts } from './plans/plan-facts';
import { ProjectsService } from './projects';
import { resolveRepoIdentity, type GitRun, type RepoIdentityOptions } from './repo-identity';
import type { RegisteredProject } from './store/project-registry';
import { AgencySettingsService, type AgencySettingsAccess } from './settings';
import { agencyDbPath } from './store/agency-db';
import { AgencyStore, type AgencyTouched, type AskQuestionInput } from './store/agency-store';

const MERGE_CLOSED = 'The job closed before the merge finished.';

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
  /** Git that writes: worktrees, the umbrella bump. Defaults to git on the PATH. */
  gitWrite?: GitWrite;
  /** Removes a job's worktrees at close, never forced. */
  worktrees?: WorktreeRemover;
  /** Whether Fleet is online, so failed cleanup steps are retried. */
  isOnline?: () => boolean;
  /** Seams for cleanup tests: how a kind of resource is undone. */
  cleaners?: Partial<Record<ResourceKind, ResourceCleaner>>;
  /** Fleet's agency settings, which the Admiral's settings tools change; in memory unless set. */
  agencySettings?: AgencySettingsAccess;
};

/** Agency settings kept in memory, for a service with no settings file behind it. */
function memorySettings(): AgencySettingsAccess {
  let settings = DEFAULT_AGENCY_SETTINGS;
  return { get: () => settings, set: (next) => void (settings = next) };
}

/**
 * The agency's main-process side: the store, the one-per-repo registry, and
 * the operations the renderer reaches through IPC. Every write that changes
 * what an Admiral pane shows raises a change event for its repository.
 */
const realpathOrNull = async (path: string): Promise<string | null> =>
  realpath(path).catch(() => null);

/** A workspace project as a folder inside it resolves: the umbrella's git directory, or none for a folder. */
function projectResolution(project: RegisteredProject): RepoResolution {
  return {
    ok: true,
    repoId: project.id,
    root: project.root,
    name: project.name,
    gitCommonDir: project.members.find((m) => m.path === '.')?.gitCommonDir ?? null,
    superprojectRoot: null,
    superprojectRepoId: null
  };
}

export class AgencyService {
  readonly store: AgencyStore;
  readonly registry = new AdmiralRegistry();
  readonly projects: ProjectsService;
  readonly jobs: JobsService;
  readonly cleanup: CleanupRunner;
  readonly results: ResultsService;
  readonly prs: PrCards;
  readonly clientFiles: ClientFiles;
  readonly settings: AgencySettingsService;
  readonly workspaces: JobWorkspaces;
  readonly merges: MergeQueue;

  constructor(private readonly deps: AgencyServiceDeps) {
    this.store = new AgencyStore(deps.dbPath ?? agencyDbPath(), { now: deps.now });
    this.clientFiles = new ClientFiles({
      store: this.store,
      home: () => deps.agencyHome ?? agencyHome(),
      now: () => new Date(deps.now?.() ?? Date.now())
    });
    this.projects = new ProjectsService({
      store: this.store,
      clientFiles: this.clientFiles,
      resolve: async (path) => this.resolveRepo(path),
      identify: async (path) => this.identify(path),
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
          { members: projectMembers(this.store.projects, repo).members, plan, others, pinned },
          { git: deps.git ?? readOnlyGit, gh: deps.gh ?? nativeGh }
        );
      }
    });
    this.prs = new PrCards({
      store: this.store,
      gh: deps.gh ?? nativeGh,
      home: () => deps.agencyHome ?? agencyHome(),
      now: () => deps.now?.() ?? Date.now(),
      changed: (touched) => this.changed(touched)
    });
    this.results = new ResultsService({
      store: this.store,
      gh: deps.gh ?? nativeGh,
      git: deps.git ?? readOnlyGit,
      home: () => deps.agencyHome ?? agencyHome(),
      cards: this.prs,
      changed: (touched) => this.changed(touched),
      afterResult: (jobId) => this.jobs.afterStepChange(jobId)
    });
    this.settings = new AgencySettingsService({
      store: this.store,
      agency: deps.agencySettings ?? memorySettings(),
      home: () => deps.agencyHome ?? agencyHome(),
      changed: (repoId, jobId) => deps.emit({ repoId, jobIds: [jobId], settings: true })
    });
    this.workspaces = new JobWorkspaces({
      store: this.store,
      home: () => deps.agencyHome ?? agencyHome(),
      git: deps.gitWrite
    });
    this.merges = new MergeQueue({
      store: this.store,
      gh: deps.gh ?? nativeGh,
      git: deps.git ?? readOnlyGit,
      results: this.results,
      prs: this.prs,
      bump: async (input) =>
        pushUmbrellaBump(input, {
          store: this.store,
          home: () => deps.agencyHome ?? agencyHome(),
          git: deps.gitWrite
        }),
      changed: (touched) => this.changed(touched)
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
      closeNotes: async (jobId) => this.prs.closeNotes(jobId),
      isOnline: deps.isOnline ?? (() => true)
    });
    // No turn from before this start is still running, so every claim made
    // then is stale, and its wakeups are due again.
    const released = this.store.releaseStaleClaims(0);
    if (released > 0) log.info('released wakeup claims left from the last run', { released });
  }

  /** The git repository a folder is in, whether or not it belongs to a workspace project. */
  async identify(
    cwd: string,
    opts: Omit<RepoIdentityOptions, 'git' | 'realpath'> = {}
  ): Promise<RepoResolution> {
    return resolveRepoIdentity(cwd, { ...opts, ...this.deps.repoIdentity });
  }

  /**
   * The project a folder belongs to: its repository, or the workspace project
   * that repository is a member of, so a member checkout or any worktree of it
   * finds the project's Admiral. A folder project's own folder, which is no
   * repository, resolves to that project too.
   */
  async resolveRepo(
    cwd: string,
    opts: Omit<RepoIdentityOptions, 'git' | 'realpath'> = {}
  ): Promise<RepoResolution> {
    const res = await this.identify(cwd, opts);
    const registry = this.store.projects;
    if (res.ok) {
      const project = registry.ofRepo(res.repoId);
      return project === null || project.id === res.repoId ? res : projectResolution(project);
    }
    if (res.reason !== 'not-a-repo') return res;
    const real = await (this.deps.repoIdentity?.realpath ?? realpathOrNull)(cwd);
    const project = real === null ? null : registry.holdingFolder(real);
    return project === null ? res : projectResolution(project);
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
    return {
      ...this.store.snapshot(repoId),
      clientFileChanged: this.clientFiles.changedOutside(repoId)
    };
  }

  answer(req: AgencyAnswerRequest): AgencyQuestion | null {
    if (!this.approveClientFile(req)) return null;
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

  /**
   * Approving a `client_file` card writes its lines first, so they are on disk
   * before the wakeup that reports them runs. Refused while the file has a
   * change from outside Fleet the client has not kept: approving would keep
   * it without the client seeing it.
   */
  private approveClientFile(req: AgencyAnswerRequest): boolean {
    const q = this.store.getQuestion(req.id);
    if (q?.kind !== 'client_file' || q.status !== 'open' || req.option !== 0) return true;
    if (q.proposal === null || this.clientFiles.changedOutside(q.repoId)) return false;
    this.clientFiles.apply(q.repoId, {
      name: this.store.repo(q.repoId)?.name ?? q.repoId,
      source: q.jobId === null ? 'the lobby' : `job ${jobDisplayId(q.jobId)}`,
      proposal: q.proposal
    });
    return true;
  }

  /**
   * Put a client file change up as a card in `scope`'s name. Each line it
   * replaces or removes has to be in the file now, so the card shows what
   * really goes.
   */
  proposeClientFile(
    scope: AdmiralThreadScope,
    input: { reason: string; proposal: ClientFileProposal }
  ): { ok: true; question: AgencyQuestion } | { ok: false; reason: string } {
    if (this.clientFiles.changedOutside(scope.repoId)) {
      return {
        ok: false,
        reason:
          'the client file changed outside Fleet. Ask the client to look at it in Settings > Agency > Admiral first.'
      };
    }
    const entries = clientEntries(this.clientFiles.read(scope.repoId));
    const named = [
      ...input.proposal.add.flatMap((a) => (a.replaces === null ? [] : [a.replaces])),
      ...input.proposal.remove
    ];
    const missing = named.find((line) => !entries.some((e) => sameText(e, line)));
    if (missing !== undefined) {
      return {
        ok: false,
        reason: `"${missing}" is not a line in the client file. Give the line word for word, as your note shows it, without its "(from ...)" tag.`
      };
    }
    const onlyAdds = named.length === 0;
    const question = this.store.askQuestion({
      ...scope,
      kind: 'client_file',
      question: onlyAdds ? 'Remember this for future jobs?' : 'Change the client file?',
      context: input.reason,
      options: [{ label: onlyAdds ? 'Remember it' : 'Change it' }, { label: 'Not now' }],
      recommended: 0,
      proposal: input.proposal
    });
    if (scope.jobId !== null) this.jobs.refreshClientHold(scope.jobId);
    this.changed([scope]);
    return { ok: true, question };
  }

  /** The client saved the client file in Settings: hand edits win. */
  writeClientFile(input: { repoId: string; text: string }): void {
    this.clientFiles.write(input.repoId, input.text);
    this.changed([{ repoId: input.repoId, jobId: null }]);
  }

  /**
   * A job that ended, as Markdown with a file name to save it under. Null for
   * a job still open: its record is not done yet.
   */
  exportJob(jobId: number): { name: string; text: string } | null {
    const detail = this.jobs.detail(jobId);
    if (detail === null || !TERMINAL_JOB_STATES.includes(detail.job.state)) return null;
    const { job } = detail;
    const text = exportJob({
      project: this.store.repo(job.repoId)?.name ?? job.repoId,
      detail,
      questions: this.store.listQuestions(job.repoId, { jobId })
    });
    const slug = job.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return { name: `${jobDisplayId(jobId)}-${slug || 'job'}.md`, text };
  }

  /** The client keeps a change made outside Fleet as it is. */
  keepClientFile(repoId: string): void {
    this.clientFiles.keep(repoId);
    this.changed([{ repoId, jobId: null }]);
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
    for (const id of ids) this.merges.stop(id, MERGE_CLOSED);
    this.closing(ids);
    if (ids.length > 0) this.changed(ids.map((jobId) => ({ repoId, jobId })));
    return ids;
  }

  /** The client cancels a job, or accepts what it delivered: it closes and cleans up. */
  closeJob(control: JobControl): JobControlResult {
    if (control.action === 'accept' && this.merges.merging(control.jobId)) {
      return {
        ok: false,
        reason: `${jobDisplayId(control.jobId)} is merging. Accept once the merge is done, or cancel the job.`
      };
    }
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
    this.merges.stop(control.jobId, MERGE_CLOSED);
    this.closing([control.jobId]);
    if (job) this.changed([{ repoId: job.repoId, jobId: job.id }]);
    return { ok: true };
  }

  /** The client asks to merge a delivered job's PRs, in member order. */
  async mergePrs(jobId: number): Promise<JobControlResult> {
    return this.merges.start(jobId);
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
    this.merges.startTicking();
    this.prs.startWatching();
    await Promise.all([this.cleanup.resumeAll(), this.merges.advanceAll(), this.prs.watchAll()]);
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
  clientFileForNote(repoId: string): ClientFileNote | null {
    return this.clientFiles.forNote(repoId);
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
    this.merges.stopTicking();
    this.prs.stopWatching();
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
