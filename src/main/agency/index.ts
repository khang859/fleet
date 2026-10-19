import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENCY_SETTINGS,
  REMEMBER_OPTION,
  TERMINAL_JOB_STATES,
  jobDisplayId,
  questionDisplayId,
  type AdmiralClaimResult,
  type AdmiralThreadScope,
  type AgencyAnswerRequest,
  type AgencyChanged,
  type AgencyJob,
  type AgencyPreflight,
  type AgencyQuestion,
  type AgencyRepoRef,
  type AgencySnapshot,
  type BudgetRaise,
  type ClientFileProposal,
  type RepoResolution,
  type WakeupPull,
  type WakeupRelease
} from '../../shared/agency';
import { clientEntries, sameText, YOU_LAYER } from '../../shared/agency-client-file';
import { CLIENT_LINE_MAX_CHARS } from '../../shared/agency-tools';
import type {
  AutoStartRule,
  ClientLineChange,
  ClientLineResult
} from '../../shared/agency-projects';
import { createLogger } from '../logger';
import type {
  HoldRequest,
  HoldResult,
  JobControl,
  JobControlResult,
  LeftoverAction,
  PlanBases,
  ResourceKind
} from '../../shared/agency-jobs';
import { WorktreeService } from '../worktree-service';
import { AdmiralRegistry } from './admiral-registry';
import { HeldDecisions } from './held-decisions';
import { canDecide } from './plans/plan-rules';
import { defaultCleaners, type WorktreeRemover } from './cleanup/cleaners';
import { CleanupRunner, type ResourceCleaner } from './cleanup/cleanup-runner';
import {
  CLAUDE_MODEL_NAMES,
  defaultAtOnce,
  RoleSaveSchema,
  type CrewCatalog,
  type CrewModel,
  type CrewRuntime,
  type CrewRuntimeView,
  type EvaServer,
  type RoleSave,
  type RoleSaveResult,
  type RuntimeCheck,
  type RuntimeTestResult
} from '../../shared/agency-crew';
import type {
  PermissionAnswerRequest,
  PermissionAnswerResult
} from '../../shared/agency-permissions';
import type { MemberSkills } from '../../shared/agency-agent-files';
import type { Plan } from '../../shared/agency-plan';
import {
  asNewRole,
  crewSnapshot,
  crewSources,
  loadCrew,
  NO_CREW_DIRS,
  projectCrewDir,
  roleFileText,
  saveNewRoles,
  saveRole,
  type CrewDirs
} from './crew/catalog';
import { CrewService, inATurn, type CrewPaneHost } from './crew/crew-service';
import { testRuntime, type RuntimeTestDeps } from './crew/runtime-test';
import { CrewPermissions, type PermissionDeps } from './crew/permissions';
import { JobsService, NO_CREW, type CrewControl } from './jobs';
import { StackSlots } from './jobs/stack-slots';
import { OPEN_JOB_STATES } from './jobs/job-machine';
import { ServerWatch } from './workspaces/server-watch';
import { exportJob } from './jobs/job-export';
import { reconcileAtStartup } from './jobs/reconcile';
import { runPreflight, type Probe } from './preflight';
import { ClientFiles, type PreferencesNote } from './projects/client-file';
import { nativeGh, type GhRun } from './projects/gh';
import { envSecrets } from './projects/env-files';
import { maskInLogs, Redactor } from '../redactor';
import { agencyHome } from './projects/paths';
import { loadSetup } from './projects/project-store';
import { projectPath } from './projects/setup-findings';
import { PrCards } from './results/pr-cards';
import { ResultsService } from './results';
import { readOnlyGit } from './projects/repo-reader';
import { memberSkills } from './projects/repo-skills';
import { projectMembers, type ProjectMember } from './projects/workspace-projects';
import { claudeTrustFolder, JobWorkspaces, type GitWrite } from './workspaces/job-workspace';
import { pushUmbrellaBump } from './workspaces/umbrella-bump';
import { MergeQueue } from './results/merge-queue';
import type { OtherJobPaths } from './plans/overlap';
import type { PlanFacts } from './plans/plan-checks';
import { gatherPlanFacts } from './plans/plan-facts';
import { ProjectsService } from './projects';
import { resolveRepoIdentity, type GitRun, type RepoIdentityOptions } from './repo-identity';
import type { RegisteredProject } from './store/project-registry';
import { AgencySettingsService, type AgencySettingsAccess } from './settings';
import { agencyDbPath } from './store/agency-db';
import { AgencyStore, type AgencyTouched, type AskQuestionInput } from './store/agency-store';
import { SpendService } from './spend/spend-service';
import { Understanding, type AdmiralCompletion } from './understanding';
import { pctText, usdText } from '../../shared/agency-spend';

const PASSING_RUNTIME = { path: null, version: null, checks: [] };

/** Crew stop as their pane's process ends; a pane is live while its process runs. */
const paneControl = (panes: CrewPaneHost): CrewControl => ({
  stop: async (paneId) => {
    panes.kill(paneId);
    return Promise.resolve();
  },
  livePanes: () => panes.live()
});

const MERGE_CLOSED = 'The job closed before the merge finished.';
/** How many of a crew pane's last lines the client's permission reader shows. */
const CREW_TAIL_LINES = 12;

/** The client file an answer to a `client_file` card writes, or null when it writes none. */
function answerLayer(
  repoId: string,
  proposal: ClientFileProposal,
  option: number | undefined
): string | null {
  if (proposal.topic === null) {
    if (option !== 0) return null;
    return proposal.layer === 'you' ? YOU_LAYER : repoId;
  }
  if (option === REMEMBER_OPTION.project) return repoId;
  return option === REMEMBER_OPTION.all ? YOU_LAYER : null;
}

/** A line the client typed on a Remember this? card, on one line and within a line's length. */
const clientWords = (text: string | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, CLIENT_LINE_MAX_CHARS);

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
  /** Fleet's terminal panes, which crew are hired into. Unset, nothing can be hired. */
  crewPanes?: CrewPaneHost;
  /** How crew panes are stopped, for tests; unset, through `crewPanes`. */
  crew?: CrewControl;
  /** Crew pane and session ids; random UUIDs unless set. */
  newCrewId?: () => string;
  /** Read-only git for the pre-approval check. */
  git?: GitRun;
  /**
   * The crew folders outside a project: what Fleet ships and `~/.fleet/crew/`.
   * Unset (tests of other parts), plans name any role and approval keeps no crew.
   */
  crewDirs?: CrewDirs;
  /** Whether crew can run on a runtime in a folder. Unset, every runtime passes. */
  checkRuntime?: (runtime: CrewRuntime, cwd: string) => Promise<RuntimeCheck>;
  /**
   * eva's model server as a crew pane in a folder sees it, and whether eva
   * has a key, never the key itself. Unset, eva has none.
   */
  evaServer?: (cwd: string) => Promise<{ server: EvaServer; keySet: boolean | null }>;
  /** Whether Claude Code is signed in for a crew pane in a folder, never the login itself. */
  claudeSignedIn?: (cwd: string) => Promise<boolean | null>;
  /** The models an eva server lists, or null when the list is unknown. */
  evaModels?: (server: EvaServer) => Promise<CrewModel[] | null>;
  /** How the Test button starts a runtime where no pane shows it. Unset, it cannot run. */
  runtimeTest?: Omit<RuntimeTestDeps, 'dir'>;
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
  /** The permission hooks Fleet holds for crew. Unset, no answer reaches a crew member. */
  permissionHooks?: Pick<PermissionDeps, 'respond' | 'pending'>;
  /** One call on the Admiral's model, for Read your work. Unset, it cannot read. */
  admiralCompletion?: AdmiralCompletion;
  /** The client's home folder, where Read your work reads `~/.claude/CLAUDE.md`. Defaults to the real one. */
  userHome?: string;
};

const NO_PERMISSION_HOOKS: Pick<PermissionDeps, 'respond' | 'pending'> = {
  respond: () => false,
  pending: () => undefined
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
  readonly stack: StackSlots;
  readonly servers: ServerWatch;
  readonly merges: MergeQueue;
  readonly crew: CrewService;
  readonly permissions: CrewPermissions;
  private readonly held: HeldDecisions;
  readonly spend: SpendService;
  readonly understanding: Understanding;
  /** How crew panes are stopped and found live. */
  private readonly crewControl: CrewControl;
  /** Folders already written to the trust table this run. */
  private readonly claudeFolders = new Set<string>();
  /** Fleet's agency settings, in Fleet's settings file or in memory. */
  private readonly agencySettings: AgencySettingsAccess;
  /** Whether eva's server was on this machine when last read, for eva's default crew at once. */
  private evaLocal = false;
  /** The Test button's run for each runtime, while one runs. */
  private readonly runtimeTests = new Map<CrewRuntime, Promise<RuntimeTestResult>>();

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
    const panes = deps.crewPanes ?? null;
    const agencySettings = deps.agencySettings ?? memorySettings();
    this.agencySettings = agencySettings;
    this.crewControl = deps.crew ?? (panes === null ? NO_CREW : paneControl(panes));
    this.spend = new SpendService({
      store: this.store,
      settings: () => agencySettings.get().admiral,
      changed: (touched) => this.changed(touched),
      now: () => deps.now?.() ?? Date.now(),
      working: (sessionId) => inATurn(panes?.session(sessionId)),
      interruptCrew: (jobId, why) => this.crew.interruptJob(jobId, why),
      admitQueued: () => this.jobs.admitQueued()
    });
    this.understanding = new Understanding({
      store: this.store,
      clientFiles: this.clientFiles,
      spend: this.spend,
      git: deps.git ?? readOnlyGit,
      gh: deps.gh ?? nativeGh,
      userHome: deps.userHome ?? homedir(),
      root: async (repo) => this.projects.projectRoot(repo),
      rules: async (repo) => this.projects.ruleCandidates(repo),
      redactor: async (repoId) => this.redactor(repoId),
      complete: deps.admiralCompletion ?? null,
      emit: (repoId) => deps.emit({ repoId, jobIds: [] })
    });
    this.servers = new ServerWatch({
      store: this.store,
      changed: (touched) => this.changed(touched)
    });
    this.stack = new StackSlots({
      store: this.store,
      home: () => deps.agencyHome ?? agencyHome(),
      admit: () => this.jobs.admitQueued()
    });
    this.jobs = new JobsService({
      store: this.store,
      crew: this.crewControl,
      changed: (touched) => this.changed(touched),
      crewLimit: (runtime) => this.crewAtOnce(runtime),
      stack: this.stack,
      servers: (jobId) => this.servers.servers(jobId),
      spend: (job) => this.spend.jobSpend(job),
      claudeReserve: () => this.spend.claudeWait()?.why ?? null,
      monthlyCapUsd: () => agencySettings.get().admiral.monthlyCapUsd,
      defaultWeekPct: () => agencySettings.get().admiral.defaultBudgetWeekPct,
      preferenceLines: (repoId) => [
        ...this.clientFiles.noteLines(YOU_LAYER),
        ...this.clientFiles.noteLines(repoId)
      ],
      autoStart: (repoId) => this.autoStartRule(repoId),
      delivered: (jobId) => void this.shipIt(jobId),
      planFacts: async (input) => this.planFacts(input),
      crewSnapshot: deps.crewDirs
        ? async (job, plan) => crewSnapshot(await this.crewCatalog(job.repoId), plan)
        : undefined,
      saveRoles: deps.crewDirs
        ? async (job, plan) =>
            saveNewRoles(
              projectCrewDir(job.repoId, deps.agencyHome ?? agencyHome()),
              plan.newRoles,
              await this.crewCatalog(job.repoId)
            )
        : undefined
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
      agency: agencySettings,
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
      changed: (touched) => this.changed(touched),
      shipped: (jobId) => this.shipped(jobId)
    });
    this.crew = new CrewService({
      store: this.store,
      jobs: this.jobs,
      workspaces: this.workspaces,
      stack: this.stack,
      panes,
      home: () => deps.agencyHome ?? agencyHome(),
      changed: (touched) => this.changed(touched),
      now: () => deps.now?.() ?? Date.now(),
      newId: deps.newCrewId,
      nudgeLimit: () => agencySettings.get().admiral.nudgeLimit,
      defaultModel: (runtime) => agencySettings.get().crew[runtime].defaultModel || undefined,
      spend: this.spend
    });
    this.permissions = new CrewPermissions({
      store: this.store,
      ...(deps.permissionHooks ?? NO_PERMISSION_HOOKS),
      admiralOpen: (repoId) => this.registry.claimed(repoId),
      expirySec: () => agencySettings.get().admiral.permissionExpirySec,
      refreshClientHold: (jobId) => this.jobs.refreshClientHold(jobId),
      changed: (touched) => this.changed(touched),
      now: () => deps.now?.() ?? Date.now()
    });
    this.held = new HeldDecisions({
      run: async (request) => this.carryOut(request),
      changed: (touched) => this.changed(touched),
      now: () => deps.now?.() ?? Date.now()
    });
    const crew = this.crewControl;
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
   * could have claimed them, and it will never ack them. The permission
   * requests that waited on its Admiral go to the client, since a crew member
   * cannot wait for the pane to open again.
   */
  release(paneId: string): void {
    for (const repoId of this.registry.release(paneId)) this.unclaimed(repoId);
  }

  /** A window reloaded or closed: the same, for every repository it held. */
  releaseOwner(owner: number): void {
    for (const repoId of this.registry.releaseOwner(owner)) this.unclaimed(repoId);
  }

  private unclaimed(repoId: string): void {
    this.store.unclaimWakeups(repoId);
    this.permissions.admiralGone(repoId);
    // The pane that could undo them is gone, so they go through now.
    void this.held.runAll(repoId);
  }

  /**
   * A plan or question decision from the Bridge: held for `HOLD_MS`, then
   * carried out as the card's own click is, unless undone. Settles with how
   * it ended. Refused at once when the item no longer waits on the client.
   */
  async hold(request: HoldRequest): Promise<HoldResult> {
    const target = this.holdTarget(request);
    if (!target.ok) return { outcome: 'refused', reason: target.reason };
    return this.held.hold(target.repoId, target.decision, request);
  }

  /** Drop a held decision before it runs. */
  undo(holdId: number): boolean {
    return this.held.undo(holdId);
  }

  /** Whether any decision is held, which a quit carries out first. */
  hasHeld(): boolean {
    return !this.held.isEmpty();
  }

  /** Carry out every held decision now, before Fleet quits. */
  async runHeld(): Promise<void> {
    await this.held.runAll();
  }

  /** The repository, job and line of a held decision, or why it cannot be held. */
  private holdTarget(
    request: HoldRequest
  ):
    | { ok: true; repoId: string; decision: { jobId: number | null; key: string; label: string } }
    | { ok: false; reason: string } {
    if (request.kind === 'answer') {
      const q = this.store.getQuestion(request.answer.id);
      if (q?.status !== 'open') {
        return { ok: false, reason: `${questionDisplayId(request.answer.id)} is not open.` };
      }
      return {
        ok: true,
        repoId: q.repoId,
        decision: { jobId: q.jobId, key: `q:${q.id}`, label: `Answered ${questionDisplayId(q.id)}` }
      };
    }
    const { action } = request;
    const version = this.store.plans.version(action.planVersionId);
    const verdict = canDecide(
      version,
      version === null ? null : this.store.plans.newest(version.jobId)
    );
    if (!verdict.ok) return verdict;
    const job = version === null ? null : this.store.getJob(version.jobId);
    if (!job || version === null) return { ok: false, reason: 'There is no such plan version.' };
    const verb = { approve: 'Approved', reject: 'Rejected', revise: 'Asked for a change to' }[
      action.action
    ];
    return {
      ok: true,
      repoId: job.repoId,
      decision: {
        jobId: job.id,
        key: `plan:${version.id}`,
        label: `${verb} plan v${version.version}`
      }
    };
  }

  /** A held decision's time came: carry it out as the card's own click would. */
  private async carryOut(request: HoldRequest): Promise<HoldResult> {
    if (request.kind === 'plan') {
      const result = await this.jobs.decide(request.action);
      return result.ok ? { outcome: 'done' } : { outcome: 'refused', reason: result.reason };
    }
    return this.answer(request.answer) === null
      ? { outcome: 'refused', reason: `${questionDisplayId(request.answer.id)} is not open.` }
      : { outcome: 'done' };
  }

  /** The client answers a permission card. */
  answerPermission(req: PermissionAnswerRequest): PermissionAnswerResult {
    return this.permissions.answerAsClient(req);
  }

  ensureLobby(repo: AgencyRepoRef): string {
    return this.store.ensureLobby(repo);
  }

  snapshot(repoId: string): AgencySnapshot {
    return {
      ...this.store.snapshot(repoId),
      clientFileChanged: this.clientFiles.changedOutside(repoId),
      held: this.held.list(repoId)
    };
  }

  answer(req: AgencyAnswerRequest): AgencyQuestion | null {
    if (!this.applyClientFile(req)) return null;
    const outcome = this.store.answerQuestion(req);
    if (!outcome) return null;
    const { kind, jobId } = outcome.question;
    // Cancel on the Resume card closes the job, which cleanup has to run for.
    if (kind === 'resume' && req.option === 1 && jobId !== null) {
      this.closeJob({ jobId, action: 'cancel' });
    }
    if (kind === 'budget' && jobId !== null) this.answerBudget(outcome.question, req.option);
    if (outcome.question.jobId !== null) this.jobs.refreshClientHold(outcome.question.jobId);
    this.changed([{ repoId: outcome.question.repoId, jobId: outcome.question.jobId }]);
    return outcome.question;
  }

  /**
   * The client's pick on a raise-or-stop card: raise the job's budget, or the
   * monthly cap, and let it go on if that leaves room; or cancel the job.
   */
  private answerBudget(q: AgencyQuestion, option: number | undefined): void {
    const job = q.jobId === null ? null : this.store.getJob(q.jobId);
    if (!job) return;
    if (option === 1) {
      this.closeJob({ jobId: job.id, action: 'cancel' });
      return;
    }
    if (option !== 0 || q.raise === null) return;
    const line =
      q.raise.target === 'cap' ? this.raiseCap(job, q.raise.to) : this.raiseJob(job, q.raise);
    if (line === null) return;
    this.store.enqueueWakeup({
      repoId: job.repoId,
      jobId: job.id,
      kind: 'client_action',
      payload: { line }
    });
    // A raised cap frees every job it held; each of their Admirals hears of it.
    if (q.raise.target === 'cap') this.spend.recheck();
    else this.spend.recheck(job.id, false);
  }

  private raiseCap(job: AgencyJob, to: number): string {
    const agency = this.agencySettings.get();
    this.agencySettings.set({ ...agency, admiral: { ...agency.admiral, monthlyCapUsd: to } });
    this.deps.emit({ repoId: job.repoId, jobIds: [], settings: true });
    return `The client raised the monthly cap to ${usdText(to)}`;
  }

  /** The job's budget raised as a plan version the client approved; null when it has no plan. */
  private raiseJob(job: AgencyJob, { target, to }: BudgetRaise): string | null {
    const budget = { ...(this.store.plans.approved(job.id)?.plan.budget ?? { usd: to }) };
    if (target === 'usd') budget.usd = to;
    else budget.weekPct = to;
    const version = this.jobs.raiseBudget(job.id, budget);
    if (version === null) return null;
    return target === 'usd'
      ? `The client raised the budget to ${usdText(to)} (plan v${version})`
      : `The client raised the share of the weekly Claude limit to ${pctText(to)} (plan v${version})`;
  }

  /**
   * Answering a `client_file` card writes its lines first, so they are on disk
   * before the wakeup that reports them runs. On a Remember this? card, This
   * project and All projects save the line, in the client's words when they
   * typed some, and Just this job declines the topic for the project. Refused
   * while the file has a change from outside Fleet the client has not kept:
   * writing would keep it without the client seeing it.
   */
  private applyClientFile(req: AgencyAnswerRequest): boolean {
    const q = this.store.getQuestion(req.id);
    if (q?.kind !== 'client_file' || q.status !== 'open' || q.proposal === null) return true;
    const { proposal } = q;
    if (proposal.topic !== null && req.option === REMEMBER_OPTION.decline) {
      this.store.preferences.declineTopic(q.repoId, proposal.topic);
      return true;
    }
    const layer = answerLayer(q.repoId, proposal, req.option);
    if (layer === null) return true;
    if (this.clientFiles.changedOutside(layer)) return false;
    const typed = proposal.topic === null ? '' : clientWords(req.text);
    this.clientFiles.apply(layer, {
      name: layer === YOU_LAYER ? 'You' : (this.store.repo(q.repoId)?.name ?? q.repoId),
      source: q.jobId === null ? 'the Bridge' : `job ${jobDisplayId(q.jobId)}`,
      proposal: typed === '' ? proposal : { ...proposal, add: [{ text: typed, replaces: null }] }
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
    const { topic } = input.proposal;
    const layer = input.proposal.layer === 'you' ? YOU_LAYER : scope.repoId;
    if (this.clientFiles.changedOutside(layer)) {
      return {
        ok: false,
        reason:
          'the client file changed outside Fleet. Ask the client to look at it in Settings > Agency > Admiral first.'
      };
    }
    if (topic !== null) {
      const refused = this.topicRefusal(scope.repoId, topic);
      if (refused !== null) return { ok: false, reason: refused };
    }
    const entries = clientEntries(this.clientFiles.read(layer));
    const named = [
      ...input.proposal.add.flatMap((a) => (a.replaces === null ? [] : [a.replaces])),
      ...input.proposal.remove
    ];
    const missing = named.find((line) => !entries.some((e) => sameText(e, line)));
    if (missing !== undefined) {
      return {
        ok: false,
        reason: `"${missing}" is not a line in the client file. Give the line word for word, as your note shows it, without its id and its "(from ...)" tag.`
      };
    }
    const question = this.store.askQuestion({
      ...scope,
      kind: 'client_file',
      ...(topic === null
        ? {
            question: 'Change the client file?',
            options: [{ label: 'Change it' }, { label: 'Not now' }],
            recommended: 0
          }
        : {
            question: 'Remember this?',
            options: [
              { label: 'This project' },
              { label: 'All projects' },
              { label: scope.jobId === null ? 'Just this time' : 'Just this job' }
            ],
            recommended: input.proposal.layer === 'you' ? 1 : 0
          }),
      context: input.reason,
      proposal: input.proposal
    });
    if (scope.jobId !== null) this.jobs.refreshClientHold(scope.jobId);
    this.changed([scope]);
    return { ok: true, question };
  }

  /** Why a Remember this? card on `topic` may not go up now, or null when it may. */
  private topicRefusal(repoId: string, topic: string): string | null {
    if (this.store.preferences.topicDeclined(repoId, topic)) {
      return `the client said Just this job to "${topic}" before. Do not ask about it again on this project.`;
    }
    const open = this.store
      .listQuestions(repoId, { statuses: ['open'] })
      .find((q) => q.kind === 'client_file' && q.proposal?.topic === topic);
    return open === undefined
      ? null
      : `${questionDisplayId(open.id)} asks about "${topic}" already. Wait for the client's answer.`;
  }

  /** The client saved the client file in Settings: hand edits win. */
  writeClientFile(input: { layer: string; text: string }): void {
    this.clientFiles.write(input.layer, input.text);
    this.layerChanged(input.layer);
  }

  /** The client added, edited or removed one line on the What the Admiral knows page. */
  changeClientLine(input: { layer: string; change: ClientLineChange }): ClientLineResult {
    const { layer, change } = input;
    const result = this.clientFiles.changeLine(layer, change);
    if (!result.ok) return result;
    if (change.kind === 'edit') this.store.preferences.moveUses(layer, change.was, change.text);
    this.layerChanged(layer);
    return result;
  }

  /**
   * A job that ended, as Markdown with a file name to save it under. Null for
   * a job still open: its record is not done yet.
   */
  async exportJob(jobId: number): Promise<{ name: string; text: string } | null> {
    const detail = this.jobs.detail(jobId);
    if (detail === null || !TERMINAL_JOB_STATES.includes(detail.job.state)) return null;
    const { job } = detail;
    const text = exportJob(
      {
        project: this.store.repo(job.repoId)?.name ?? job.repoId,
        detail,
        questions: this.store.listQuestions(job.repoId, { jobId })
      },
      await this.envSecrets(job.repoId)
    );
    const slug = job.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return { name: `${jobDisplayId(jobId)}-${slug || 'job'}.md`, text };
  }

  /**
   * The values of the env files a project's crew get, which nothing the
   * Admiral, an export or a log line shows. Each read masks them in the logs.
   */
  private async envSecrets(repoId: string): Promise<string[]> {
    const members = this.membersOf(repoId);
    if (members === null) return [];
    const values = await envSecrets(
      await loadSetup(repoId, this.deps.agencyHome ?? agencyHome()),
      members
    );
    maskInLogs(values);
    return values;
  }

  /** A known project's members, in member order. */
  private membersOf(repoId: string): ProjectMember[] | null {
    const repo = this.store.repo(repoId);
    return repo === null ? null : projectMembers(this.store.projects, repo).members;
  }

  /** The client keeps a change made outside Fleet as it is. */
  keepClientFile(layer: string): void {
    this.clientFiles.keep(layer);
    this.layerChanged(layer);
  }

  /** The client undoes a change made outside Fleet. */
  undoClientFile(layer: string): void {
    this.clientFiles.undo(layer);
    this.layerChanged(layer);
  }

  /** A project's snapshot shows its file's outside change; the You layer is in no snapshot. */
  private layerChanged(layer: string): void {
    if (layer !== YOU_LAYER) this.changed([{ repoId: layer, jobId: null }]);
  }

  /** The wakeups due for one job, as one turn's text, with env file values masked. */
  async pullWakeups(input: { repoId: string; jobId: number | null }): Promise<WakeupPull> {
    const pull = this.spend.admiralPull(input.jobId, (clientOnly) =>
      this.store.pullWakeups(input, clientOnly)
    );
    if (pull.text === null) return pull;
    return { ...pull, text: (await this.redactor(input.repoId)).redact(pull.text) };
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

  /** When the project lets Fleet start a plan on its own, and how big a plan may be. */
  private autoStartRule(repoId: string): AutoStartRule | null {
    const trust = this.store.preferences.trust(repoId);
    if (trust.level === 'ask') return null;
    const admiral = this.agencySettings.get().admiral;
    return {
      level: trust.level,
      usd: trust.autoStartUsd ?? admiral.defaultBudgetUsd,
      weekPct: admiral.defaultBudgetWeekPct
    };
  }

  /** Under Ship it, a job that delivered only PRs merges them as if the client pressed Merge. */
  private async shipIt(jobId: number): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job || this.store.preferences.trust(job.repoId).level !== 'ship') return;
    const listed = this.store.results.forJob(jobId).filter((r) => r.listed);
    if (listed.length === 0 || listed.some((r) => r.body.kind !== 'pr')) return;
    const started = await this.merges.start(jobId, 'trust');
    if (!started.ok) log.warn('Ship it could not start the merge', { jobId, ...started });
  }

  /**
   * A merge Fleet started under Ship it merged every PR: the job is accepted
   * and closes, and the Admiral reports to the client on the Bridge.
   */
  private shipped(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (!job) return;
    const prs = this.store.results
      .forJob(jobId)
      .flatMap((r) => (r.body.kind === 'pr' ? [`#${r.body.pr.number} ${r.body.pr.url}`] : []));
    this.store.plans.log({
      jobId,
      kind: 'decision',
      text: 'Ship it: merged and closed on its own'
    });
    const closed = this.closeJob({ jobId, action: 'accept' });
    if (!closed.ok) {
      log.warn('Ship it could not close the job', { jobId, reason: closed.reason });
      return;
    }
    const id = jobDisplayId(jobId);
    this.store.enqueueWakeup({
      repoId: job.repoId,
      jobId: null,
      kind: 'event',
      payload: {
        line: `${id} shipped on its own`,
        body: `The project is at Ship it, so Fleet merged every PR of ${id} once its checks passed, and closed the job: ${prs.join(', ')}. Give the client a short report of what shipped, with the PR links.`
      }
    });
    this.changed([{ repoId: job.repoId, jobId: null }]);
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
      crew: this.crewControl,
      git: this.deps.git ?? readOnlyGit
    });
    if (touched.length > 0) this.changed(touched);
    // Mask every project's env file values in the logs before crew write any.
    await Promise.all(
      this.store.listProjects().map(async (p) => this.envSecrets(p.repo.repoId).catch(() => []))
    );
    // No hook from before this start is held now, so no open request can be answered.
    const voided = this.permissions.voidAll('Fleet restarted.');
    if (voided.length > 0) this.changed(voided);
    this.cleanup.startRetrying();
    this.merges.startTicking();
    this.prs.startWatching();
    this.stack.startPolling();
    this.servers.startPolling();
    this.crew.startTicking();
    this.permissions.startTicking();
    this.spend.startTicking();
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
        throw new Error(`This conversation is not the Bridge of ${repo.name}.`);
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
    const job = scope.jobId === null ? null : this.store.getJob(scope.jobId);
    // Closing withdraws a job's questions; one asked after would wait on the client for good.
    if (job && !OPEN_JOB_STATES.includes(job.state)) {
      throw new Error(
        `Not asked: ${jobDisplayId(job.id)} is ${job.state}, so nothing more is asked on it.`
      );
    }
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

  /** What the pre-approval check reads about a job's project, its crew roles included. */
  private async planFacts(input: {
    job: AgencyJob;
    plan: Plan;
    others: OtherJobPaths[];
    pinned: PlanBases | null;
  }): Promise<PlanFacts> {
    const { job } = input;
    const repo = this.store.repo(job.repoId);
    if (!repo) throw new Error(`The project of ${jobDisplayId(job.id)} is not known.`);
    const crew = this.deps.crewDirs ? await this.crewCatalog(job.repoId) : null;
    const { kind, members } = projectMembers(this.store.projects, repo);
    const home = this.deps.agencyHome ?? agencyHome();
    const trust = claudeTrustFolder(kind, repo.root, home);
    const check = this.deps.checkRuntime;
    const setup = await loadSetup(job.repoId, home);
    return gatherPlanFacts(
      {
        ...input,
        members,
        envFiles: (setup?.members ?? []).flatMap((m) =>
          m.envFiles.map((file) => ({ member: m.name, file: projectPath(m.path, file) }))
        ),
        crew: crew && {
          roles: new Map(crew.roles.map((r) => [r.name, r.runtime])),
          roleText: new Map(crew.roles.map((r) => [r.name, roleFileText(asNewRole(r))])),
          models: new Map(
            crew.roles.flatMap((r) => (r.model === undefined ? [] : [[r.name, r.model]]))
          ),
          evaModels: async () => {
            const { models } = await this.evaModelList(repo.root);
            return models && new Set(models.map((m) => m.id));
          },
          check: async (runtime) => check?.(runtime, repo.root) ?? { ...PASSING_RUNTIME, runtime },
          claudeTrust: { folder: trust, trusted: this.store.claudeTrusted(trust) },
          memberTrust: new Map(
            members
              .filter((m) => m.path !== '.')
              .map((m) => [m.name, { folder: m.root, trusted: this.store.claudeTrusted(m.root) }])
          )
        }
      },
      { git: this.deps.git ?? readOnlyGit, gh: this.deps.gh ?? nativeGh }
    );
  }

  /**
   * A Claude Code session reported from `cwd`. It only does once its folder
   * trust prompt is answered, so the plan card stops asking for that folder.
   */
  noteClaudeSession(cwd: string): void {
    if (this.claudeFolders.has(cwd)) return;
    this.claudeFolders.add(cwd);
    this.store.noteClaudeFolder(cwd);
  }

  /** The roles and playbooks a project's jobs can use, read fresh from their files. */
  async crewCatalog(repoId: string): Promise<CrewCatalog> {
    const home = this.deps.agencyHome ?? agencyHome();
    return loadCrew(crewSources(this.deps.crewDirs ?? NO_CREW_DIRS, projectCrewDir(repoId, home)));
  }

  /**
   * The skills each member's repository has, for the Admiral to name in a
   * plan. A member it cannot read lists none rather than failing the turn.
   */
  async crewSkills(repoId: string): Promise<MemberSkills[]> {
    const members = this.membersOf(repoId);
    return members === null ? [] : memberSkills(members, this.deps.git ?? readOnlyGit);
  }

  /** Crew of a runtime that may work at once: the client's number, else the runtime's default. */
  private crewAtOnce(runtime: CrewRuntime): number {
    return this.agencySettings.get().crew[runtime].atOnce ?? defaultAtOnce(runtime, this.evaLocal);
  }

  /** The models eva crew in a folder can use, the server they come from, and whether it has a key. */
  private async evaModelList(
    cwd: string
  ): Promise<{ server: EvaServer | null; models: CrewModel[] | null; keySet: boolean | null }> {
    const read = (await this.deps.evaServer?.(cwd)) ?? null;
    if (read === null) return { server: null, models: null, keySet: null };
    this.evaLocal = read.server.local;
    const models = (await this.deps.evaModels?.(read.server)) ?? null;
    return { server: read.server, models, keySet: read.keySet };
  }

  /** Settings › Agency › Crew: each runtime as the project's crew panes would start it. */
  async crewRuntimes(repoId: string): Promise<CrewRuntimeView[]> {
    const repo = this.store.repo(repoId);
    if (!repo) throw new Error('That project is not known.');
    const check = async (runtime: CrewRuntime): Promise<RuntimeCheck> =>
      (await this.deps.checkRuntime?.(runtime, repo.root)) ?? { ...PASSING_RUNTIME, runtime };
    const [claude, signedIn, eva, evaList] = await Promise.all([
      check('claude'),
      this.deps.claudeSignedIn?.(repo.root) ?? null,
      check('eva'),
      this.evaModelList(repo.root)
    ]);
    const { keySet, ...evaServer } = evaList;
    const view = (runtime: CrewRuntime): Pick<CrewRuntimeView, 'limited' | 'defaultAtOnce'> => ({
      limited: this.crew.flags.usageLimit(runtime),
      defaultAtOnce: defaultAtOnce(runtime, evaServer.server?.local === true)
    });
    return [
      {
        check: claude,
        server: null,
        models: CLAUDE_MODEL_NAMES.map((id) => ({ id, contextLimit: null, cost: null })),
        signedIn,
        ...view('claude')
      },
      { check: eva, ...evaServer, signedIn: keySet, ...view('eva') }
    ];
  }

  /**
   * The Test button: start the runtime in a hidden terminal in the project,
   * with the default model from Settings, and say what reached Fleet. A
   * second press while one runs waits for the same run.
   */
  async testCrewRuntime(repoId: string, runtime: CrewRuntime): Promise<RuntimeTestResult> {
    const repo = this.store.repo(repoId);
    if (!repo) return { ok: false, reason: 'That project is not known.' };
    const test = this.deps.runtimeTest;
    if (!test) return { ok: false, reason: 'Fleet cannot start a terminal for the test here.' };
    const running = this.runtimeTests.get(runtime);
    if (running) return running;
    const model = this.agencySettings.get().crew[runtime].defaultModel || undefined;
    const dir = join(this.deps.agencyHome ?? agencyHome(), 'runtime-test');
    const run = testRuntime(runtime, repo.root, model, { ...test, dir }).finally(() =>
      this.runtimeTests.delete(runtime)
    );
    this.runtimeTests.set(runtime, run);
    return run;
  }

  /** Save a role from Settings › Agency › Crew in the file it came from. */
  async saveCrewRole(input: RoleSave): Promise<RoleSaveResult> {
    const { repoId, base, role } = RoleSaveSchema.parse(input);
    const dirs = this.deps.crewDirs;
    if (!this.store.repo(repoId)) return { ok: false, reason: 'That project is not known.' };
    if (!dirs) return { ok: false, reason: 'Fleet has no crew folders.' };
    const project = projectCrewDir(repoId, this.deps.agencyHome ?? agencyHome());
    return saveRole(await this.crewCatalog(repoId), { user: dirs.user, project }, { base, role });
  }

  /** The panes of a job's crew, which are all its fleet read tools may see. None in the lobby. */
  crewPanes(jobId: number | null): ReadonlySet<string> {
    return jobId === null ? new Set() : this.crew.panes(jobId);
  }

  /** A starting crew pane's screen for a job's `fleet_read`. Null for a pane that is not one. */
  async crewScreen(jobId: number | null, paneId: string): Promise<string | null> {
    return jobId === null ? null : this.crew.screen(jobId, paneId);
  }

  /**
   * The last lines a crew member's pane shows, for the client's permission
   * reader, with the project's env file values masked. Null when the pane is
   * gone or Fleet does not mirror it.
   */
  async crewTail(crewId: number): Promise<string | null> {
    const crew = this.store.crew.get(crewId);
    const job = crew === null ? null : this.store.getJob(crew.jobId);
    const text = await this.crew.paneText(crewId);
    if (!job || text === null) return null;
    const lines = text
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l !== '')
      .slice(-CREW_TAIL_LINES);
    return (await this.redactor(job.repoId)).redact(lines.join('\n'));
  }

  /** What masks a project's env file values in text the Admiral reads. */
  async redactor(repoId: string): Promise<Redactor> {
    return new Redactor(await this.envSecrets(repoId));
  }

  /** Both layers of the client's preferences for an Admiral turn's note on a project. */
  preferencesForNote(repoId: string): PreferencesNote {
    return {
      you: this.clientFiles.forNote(YOU_LAYER),
      project: this.clientFiles.forNote(repoId),
      autoStart: this.autoStartRule(repoId)
    };
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
    this.stack.stopPolling();
    this.servers.stopPolling();
    this.crew.stopTicking();
    this.permissions.stopTicking();
    this.spend.stopTicking();
    this.held.stop();
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
