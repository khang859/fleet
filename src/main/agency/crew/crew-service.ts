import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { jobDisplayId, type AgencyJob } from '../../../shared/agency';
import { isFileResultKind } from '../../../shared/agency-jobs';
import { CrewReportSchema, type CrewRuntime, type CrewSnapshot } from '../../../shared/agency-crew';
import type { PlanStep } from '../../../shared/agency-plan';
import {
  CREW_PROMPT_PREFIX,
  type AgencyToolOutput,
  type CrewHireArgs,
  type CrewInterruptArgs,
  type CrewSendArgs,
  type CrewStopArgs
} from '../../../shared/agency-tools';
import { sessionRef } from '../../agent/fleet/host';
import { ActLimiter } from '../../agent/fleet/limiter';
import type { FleetPrompter } from '../../agent/fleet/send';
import type { PaneLaunch } from '../../agent/fleet/spawns';
import type { HookEntry } from '../../claude-sessions/hook-installer';
import { cleanPrompt, PROMPT_MISMATCH, promptProblem } from '../../claude-sessions/input';
import { createLogger } from '../../logger';
import type { JobsService } from '../jobs';
import { jobDir } from '../projects/paths';
import { handbackDir } from '../results/result-files';
import type { AgencyStore, AgencyTouched } from '../store/agency-store';
import type { ResourceRecord } from '../store/resource-store';
import {
  CREW_LIVE,
  CREW_STARTING,
  LOST_AT_RESTART,
  NOT_STARTED,
  type CrewRecord
} from '../store/crew-store';
import type { StackSlots } from '../jobs/stack-slots';
import type { GitWrite, JobWorkspaces, StepFolder } from '../workspaces/job-workspace';
import { gitExec } from '../exec';
import { CrewFlags, type CrewAct, type CrewSessionState } from './crew-flags';
import { handoffNote, pendingSwap, type CrewSwap } from './handoff';
import { crewLaunch, type CrewLaunch } from './runtimes';

const log = createLogger('agency:crew');

/** A crew pane to open: unfocused, as a split of its job's one tab. */
export type CrewPaneOpen = {
  paneId: string;
  cwd: string;
  /** Names the pane, like `builder 1`. */
  label: string;
  job: { jobId: number; label: string };
  launch: PaneLaunch;
  prompt: string;
  at: number;
};

/** Fleet's terminal panes, as crew use them. */
export type CrewPaneHost = {
  /** Resolves to null once the pane is in the layout, or why it is not. */
  open(pane: CrewPaneOpen): Promise<string | null>;
  write(paneId: string, data: string): void;
  /** Ends the pane's process; the pane then closes. */
  kill(paneId: string): void;
  live(): ReadonlySet<string>;
  /** Record a prompt as Fleet's, for the session that reports from the pane. */
  notePaneInput(paneId: string, text: string): void;
  prompter: FleetPrompter;
  /** Fleet's hook entries, as its global install writes them. */
  hooks(): Record<string, HookEntry[]>;
  /** What a crew pane shows now, as text, or null when Fleet keeps no copy of it. */
  screen(paneId: string): Promise<string | null>;
  /** The Claude Code session a crew member runs, as its flags read it. */
  session(sessionId: string): CrewSessionState | undefined;
};

export type CrewServiceDeps = {
  store: AgencyStore;
  jobs: JobsService;
  workspaces: Pick<JobWorkspaces, 'open' | 'folder'>;
  /** Read ahead before each hire, so the start check knows the project's stack slots. */
  stack?: Pick<StackSlots, 'refresh'>;
  /** Unset where Fleet has no panes (tests of other parts): nothing can be hired. */
  panes: CrewPaneHost | null;
  home: () => string;
  changed: (touched: AgencyTouched[]) => void;
  now: () => number;
  newId?: () => string;
  /** How many times the Admiral may nudge a member that ends a turn without reporting. */
  nudgeLimit: () => number;
  /** The model of a role that names none, from Settings; unset leaves it to the runtime. */
  defaultModel?: (runtime: CrewRuntime) => string | undefined;
  /** Reads a swapped-out member's changes for the handoff; defaults to the `git` on PATH. */
  git?: GitWrite;
};

/**
 * The Admiral's brief, with what the plan says about the step: the skills
 * it uses, the part of the code it owns, that a step reading another's worktree
 * changes nothing in it, which members are checked out for it, what it hands
 * back and where its files go, the ports its workspace's servers use, and for a role that runs the stack, to
 * stop it so the next step gets the slot.
 */
export function stepBrief(
  step: PlanStep,
  brief: string,
  workspace: {
    env?: Record<string, string>;
    stack?: boolean;
    handback?: string;
    members?: CheckedOutMember[];
  } = {}
): string {
  const notes: string[] = [];
  if (step.skills.length > 0) {
    const names = step.skills.join(', ');
    notes.push(
      `Use ${step.skills.length === 1 ? 'the skill' : 'the skills'} ${names} for this work.`
    );
  }
  if (step.scope !== undefined) {
    notes.push(
      `Your scope is ${step.scope}. Change only that part: other crew members own the rest.`
    );
  }
  if (step.workspace !== 'new' && 'of' in step.workspace) {
    notes.push(
      `This worktree is step ${step.workspace.of}'s. Read and run it, but change and commit nothing.`
    );
  }
  const checkedOut = membersNote(step, workspace.members ?? []);
  if (checkedOut !== null) notes.push(checkedOut);
  const handsBack = handbackNote(step, workspace.handback);
  if (handsBack !== null) notes.push(handsBack);
  const note = portsNote(workspace.env ?? {});
  if (note !== null) notes.push(note);
  if (workspace.stack === true) {
    notes.push(
      'You run the stack, which holds one of the project’s stack slots. Stop every server and container you started before you finish, so the next step can run it.'
    );
  }
  return [brief, ...notes].join('\n\n');
}

/** A member worktree in a crew member's folder: where it is, relative to the folder, and its branch. */
export type CheckedOutMember = { member: string; path: string; branch: string };

/** The member worktrees inside the folder a crew member starts in, other than that folder itself. */
function checkedOut(parts: ResourceRecord[], cwd: string): CheckedOutMember[] {
  return parts.flatMap((r) =>
    r.kind === 'member_worktree' &&
    r.member !== null &&
    r.path !== null &&
    r.branch !== null &&
    r.path !== cwd
      ? [{ member: r.member, path: relative(cwd, r.path), branch: r.branch }]
      : []
  );
}

/**
 * The members Fleet checked out in a writer's folder, on the step's branch.
 * A builder in an umbrella otherwise runs `git submodule update`, which moves
 * the members off that branch, so its commits land on no branch.
 */
function membersNote(step: PlanStep, members: CheckedOutMember[]): string | null {
  if (members.length === 0 || (step.workspace !== 'new' && 'of' in step.workspace)) return null;
  const listed = members.map((m) => `${m.path} (${m.member})`).join(', ');
  return [
    `Fleet checked out ${listed} for you, on the branch ${members[0].branch}.`,
    'Commit in each one as it is.',
    'Do not run `git submodule update` or switch branches in them: that moves them off the branch.',
    'Other members are not checked out, because this step does not change them.'
  ].join(' ');
}

/**
 * What the brief says the step hands back, or null when the plan lists
 * nothing. A step that only reads another's worktree writes its files in
 * the hand-back folder, since the worktree is not its to change.
 */
function handbackNote(step: PlanStep, folder: string | undefined): string | null {
  if (step.deliverables.length === 0) return null;
  const listed = step.deliverables.map((d) => `${d.label} (${d.kind})`).join(', ');
  const lines = [`This step hands back: ${listed}.`];
  if (step.deliverables.some((d) => isFileResultKind(d.kind))) {
    if (folder !== undefined) lines.push(`Write each file it hands back in ${folder}.`);
    lines.push('Pass each file to `fleet agency done` with `--deliver <path>`.');
  }
  return lines.join(' ');
}

/** What the brief says about the workspace's ports, or null when it has none. */
function portsNote(env: Record<string, string>): string | null {
  const block = env.FLEET_PORTS as string | undefined;
  if (block === undefined) return null;
  const set = Object.entries(env)
    .filter(([name]) => name !== 'FLEET_PORTS' && name !== 'COMPOSE_PROJECT_NAME')
    .map(([name, port]) => `${name}=${port}`);
  return [
    set.length > 0
      ? `Your env sets the servers' ports: ${set.join(', ')}. Use them, never the defaults: other jobs run servers too.`
      : 'Other jobs run servers too, so never use a default port.',
    `For any other server, pick a free port in ${block} (FLEET_PORTS).`
  ].join(' ');
}

/** How a crew member's pane went away. */
export type CrewEnd = { kind: 'exit'; exitCode: number } | { kind: 'closed' };

/**
 * Hires a job's crew into panes and talks to them: `crew_hire`, `crew_send`,
 * `crew_interrupt` and `crew_stop`. Each plan step has at most one crew
 * member working. A hire is allowed only for a step of the approved plan that
 * may start, and every act is written to the job record. Each job has its own
 * rate limit, and its automatic-turn chain stops crew acts with its turns.
 */
export class CrewService {
  private readonly limiter = new ActLimiter();

  /**
   * Per crew member: whether it reported since its last turn ended, and its
   * idle turns in a row. Kept in memory, as a restart ends every member.
   */
  private readonly turns = new Map<number, { reported: boolean; idle: number }>();

  /** `needs-you`, `limited`, `user-driven` and `stuck`. */
  readonly flags: CrewFlags;

  constructor(private readonly deps: CrewServiceDeps) {
    this.flags = new CrewFlags({
      store: deps.store,
      jobs: deps.jobs,
      session: (sessionId) => deps.panes?.session(sessionId),
      touch: (jobId) => this.touch(jobId),
      now: deps.now
    });
  }

  private get store(): AgencyStore {
    return this.deps.store;
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  /** Hire the crew member for a step, or resume the one a restart took. */
  async hire(jobId: number, args: CrewHireArgs): Promise<AgencyToolOutput> {
    const panes = this.requirePanes();
    const job = this.actingJob(jobId);
    const approved = this.store.plans.approved(jobId);
    const step = approved?.plan.steps.find((s) => s.id === args.step);
    if (!approved || !step) {
      throw new Error(`Not hired: step ${args.step} is not in the approved plan.`);
    }
    const working = this.store.crew.live(jobId).find((c) => c.stepId === step.id);
    if (working) {
      throw new Error(
        `Not hired: ${working.label} (${this.refOf(working)}) is working on step ${step.id}. Talk to it with crew_send.`
      );
    }
    await this.deps.stack?.refresh(job.repoId);
    const verdict = this.deps.jobs.startCheck(jobId, step.id);
    if (!verdict.ok && verdict.queue !== true) throw new Error(`Not hired: ${verdict.reason}`);
    this.checkRate(jobId);
    if (!verdict.ok) {
      this.deps.jobs.hireMoved(jobId, step.id, 'queued', verdict.reason);
      return {
        text: `Step ${step.id} is queued: ${verdict.reason} A wakeup tells you when it can start; hire for it then.`,
        summary: `${step.id} queued`
      };
    }
    const role = approved.crew?.roles.find((r) => r.name === step.role);
    if (!role) {
      throw new Error(`Not hired: the approved plan keeps no role ${step.role}. Propose it again.`);
    }
    const held = this.flags.hireRefusal(step.runtime ?? role.runtime);
    if (held !== null) throw new Error(held);
    const before = this.store.plans.step(jobId, step.id)?.status ?? 'pending';
    const lost = before === 'interrupted' ? this.lostMember(jobId, step.id) : null;
    const swap = lost === null ? pendingSwap(this.store, jobId, step.id) : null;
    this.deps.jobs.hireMoved(jobId, step.id, 'running');
    try {
      return await this.start({ panes, job, step, role, args, lost, swap });
    } catch (err) {
      this.deps.jobs.hireMoved(jobId, step.id, before);
      throw err;
    }
  }

  private async start(input: {
    panes: CrewPaneHost;
    job: AgencyJob;
    step: PlanStep;
    role: CrewSnapshot['roles'][number];
    args: CrewHireArgs;
    lost: CrewRecord | null;
    swap: CrewSwap | null;
  }): Promise<AgencyToolOutput> {
    const { panes, job, step, role, args, lost, swap } = input;
    const runtime: CrewRuntime = step.runtime ?? role.runtime;
    const model =
      step.model ??
      (runtime === role.runtime ? role.model : undefined) ??
      this.deps.defaultModel?.(runtime);
    const workspace = await this.workspaceFor(job.id, step.id, lost, swap);
    const handback = await this.handbackFor(job.id, step);
    const brief = stepBrief(step, args.brief, {
      env: workspace.env,
      stack: role.stack,
      handback,
      members: checkedOut(this.store.resources.ofWorkspace(workspace.id), workspace.cwd)
    });
    const all = this.store.crew.all(job.id);
    const member = all.filter((c) => c.stepId === step.id).length + 1;
    const crew = this.store.crew.insert({
      jobId: job.id,
      stepId: step.id,
      role: role.name,
      runtime,
      model: model ?? null,
      label: lost?.label ?? `${role.name} ${all.filter((c) => c.role === role.name).length + 1}`,
      paneId: this.newId(),
      sessionId: lost?.sessionId ?? this.newId(),
      workspaceId: workspace.id,
      status: CREW_STARTING,
      replaces: lost?.id ?? swap?.replaced.id ?? null
    });
    try {
      const launch = crewLaunch({
        jobId: job.id,
        stepId: step.id,
        member,
        runtime,
        model,
        rolePrompt: role.prompt,
        brief: swap === null ? brief : `${brief}\n\n${await this.handoff(job, step.id, swap)}`,
        sessionId: crew.sessionId ?? '',
        resume: lost !== null,
        dir: join(jobDir(this.deps.home(), job.id), 'crew', `${step.id}-${member}`),
        addDirs: handback === undefined ? [] : [handback],
        hooks: panes.hooks()
      });
      await this.openPane(panes, job, crew, workspace, launch);
    } catch (err) {
      this.store.crew.end(crew.id, `${NOT_STARTED}: ${String(err)}`);
      throw err;
    }
    const verb = lost ? 'Resumed' : 'Hired';
    const instead = swap === null ? '' : ` in place of ${swap.replaced.label}`;
    this.record(job, step.id, `${verb} ${crew.label} for step ${step.id}${instead}`, {
      crewId: crew.id,
      runtime,
      model: model ?? null,
      why: args.why ?? null,
      expect: args.expect ?? null
    });
    return {
      text: [
        `${verb} ${crew.label} (ref ${this.refOf(crew)}) on ${runtime} for step ${step.id}${instead}, in ${workspace.cwd}.`,
        'Its pane is in the job tab. It shows as starting until its session reports; one that stays starting is probably waiting at a prompt only the client can answer.'
      ].join(' '),
      summary: `${verb.toLowerCase()} ${crew.label}`
    };
  }

  /**
   * The folder a step that reads another's worktree writes the files it
   * hands back in, made for it; none for any other step.
   */
  private async handbackFor(jobId: number, step: PlanStep): Promise<string | undefined> {
    const reads = step.workspace !== 'new' && 'of' in step.workspace;
    if (!reads || !step.deliverables.some((d) => isFileResultKind(d.kind))) return undefined;
    const folder = handbackDir(this.deps.home(), jobId, step.id);
    await mkdir(folder, { recursive: true });
    return folder;
  }

  /**
   * The step's folder: the one a resumed member left, so `--resume` finds its
   * session, or a swapped-out one's, to continue its work; else a new one.
   */
  private async workspaceFor(
    jobId: number,
    stepId: string,
    lost: CrewRecord | null,
    swap: CrewSwap | null
  ): Promise<StepFolder> {
    const left = lost ?? (swap?.choice === 'continue' ? swap.replaced : null);
    if (left !== null) {
      const folder =
        left.workspaceId === null ? null : this.deps.workspaces.folder(jobId, left.workspaceId);
      if (folder === null) throw new Error(`Not hired: ${left.label}'s workspace is gone.`);
      return folder;
    }
    try {
      return await this.deps.workspaces.open(jobId, stepId);
    } catch (err) {
      throw new Error(`Not hired: the step's workspace could not be made. ${String(err)}`);
    }
  }

  /** The handoff for a swapped-in member, from the old member's workspace and the step's open questions. */
  private async handoff(job: AgencyJob, stepId: string, swap: CrewSwap): Promise<string> {
    const { workspaceId } = swap.replaced;
    const questions = this.store
      .listQuestions(job.repoId, { jobId: job.id, statuses: ['open', 'hidden'] })
      .filter((q) => q.step === stepId)
      .map((q) => q.question);
    return handoffNote({
      swap,
      parts: workspaceId === null ? [] : this.store.resources.ofWorkspace(workspaceId),
      questions,
      git: this.deps.git ?? gitExec
    });
  }

  /** Write the launch's files, then open the member's pane in the job tab. */
  private async openPane(
    panes: CrewPaneHost,
    job: AgencyJob,
    crew: CrewRecord,
    workspace: StepFolder,
    launch: CrewLaunch
  ): Promise<void> {
    for (const file of launch.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.text);
    }
    const paneId = crew.paneId ?? '';
    panes.notePaneInput(paneId, launch.prompt);
    const at = this.deps.now();
    const error = await panes.open({
      paneId,
      cwd: workspace.cwd,
      label: crew.label,
      job: { jobId: job.id, label: `${jobDisplayId(job.id)} ${job.title}` },
      launch: { cmd: launch.cmd, env: { ...workspace.env, ...launch.env }, exitOnComplete: true },
      prompt: launch.prompt,
      at
    });
    if (error !== null) throw new Error(`Not hired: ${error}`);
    this.limiter.note(this.limitKey(job.id), at);
  }

  /** Type a prompt into a crew member that is waiting for one. */
  async send(jobId: number, args: CrewSendArgs): Promise<AgencyToolOutput> {
    const panes = this.requirePanes();
    const job = this.actingJob(jobId);
    const crew = this.resolve(jobId, args.crew, 'send');
    if (crew.runtime === 'eva') {
      throw new Error(
        `Not sent: Fleet cannot type into eva crew yet. Ask the client to type into ${crew.label}'s pane.`
      );
    }
    if (crew.status === CREW_STARTING || crew.sessionId === null) {
      throw new Error(`Not sent: ${crew.label} has not reported yet, so it cannot take a prompt.`);
    }
    const text = cleanPrompt(`${CREW_PROMPT_PREFIX} ${args.prompt}`);
    const refused = panes.prompter.refusal(crew.sessionId) ?? promptProblem(text);
    if (refused !== null) throw new Error(refused);
    this.checkRate(jobId);
    const at = this.deps.now();
    const result = await panes.prompter.send(crew.sessionId, text);
    const typed = result.ok || result.reason === PROMPT_MISMATCH;
    if (typed) {
      this.limiter.note(this.limitKey(jobId), at);
      const how = result.ok ? 'a prompt' : 'a prompt that arrived different';
      this.record(job, crew.stepId, `Sent ${crew.label} ${how}`, {
        crewId: crew.id,
        prompt: text,
        why: args.why ?? null,
        expect: args.expect ?? null
      });
    }
    if (!result.ok) throw new Error(result.reason);
    const ack = result.confirmed
      ? 'It took it and is working on it.'
      : 'It has not acknowledged it yet. Check with fleet_read before sending it again.';
    return {
      text: `Sent to ${crew.label} (${this.refOf(crew)}). ${ack}`,
      summary: `sent ${crew.label}`
    };
  }

  /** Press Esc in a crew member's pane, as the client would. */
  interrupt(jobId: number, args: CrewInterruptArgs): AgencyToolOutput {
    const panes = this.requirePanes();
    const job = this.actingJob(jobId);
    const crew = this.resolve(jobId, args.crew, 'interrupt');
    if (crew.paneId !== null) panes.write(crew.paneId, '\x1b');
    this.record(job, crew.stepId, `Interrupted ${crew.label}`, { crewId: crew.id });
    return {
      text: `Pressed Esc in ${crew.label}'s pane. It keeps its conversation and waits for a prompt.`,
      summary: `interrupted ${crew.label}`
    };
  }

  /** End a crew member's process. Its step stays as it is, so the Admiral can hire for it again. */
  async stop(jobId: number, args: CrewStopArgs): Promise<AgencyToolOutput> {
    this.requirePanes();
    const job = this.actingJob(jobId);
    const crew = this.resolve(jobId, args.crew, 'stop');
    await this.deps.jobs.stopCrew([crew.id], 'stopped by the Admiral');
    this.record(job, crew.stepId, `Stopped ${crew.label}`, {
      crewId: crew.id,
      why: args.why ?? null
    });
    return {
      text: `Stopped ${crew.label}. Its worktree and branch stay until the job closes; step ${crew.stepId} is still yours to hire for or finish.`,
      summary: `stopped ${crew.label}`
    };
  }

  /**
   * What a job's crew member shows in its pane, for one that has not
   * reported yet, so the Admiral can see a login or trust screen. Null for
   * any other pane.
   */
  async screen(jobId: number, paneId: string): Promise<string | null> {
    const crew = this.store.crew.live(jobId).find((c) => c.paneId === paneId);
    if (crew?.status !== CREW_STARTING) return null;
    return (await this.deps.panes?.screen(paneId)) ?? null;
  }

  /** The panes of a job's crew, ended ones too: all its fleet read tools may see. */
  panes(jobId: number): ReadonlySet<string> {
    return new Set(
      this.store.crew.all(jobId).flatMap((c) => (c.paneId === null ? [] : [c.paneId]))
    );
  }

  /**
   * A crew member's `fleet agency done`, over Fleet's socket: the pane it
   * runs in names it. Returns what the member's shell prints.
   */
  report(input: unknown): string {
    const parsed = CrewReportSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Not reported: ${parsed.error.issues.map((i) => i.message).join('; ')}.`);
    }
    const report = parsed.data;
    const crew = this.store.crew.live().find((c) => c.paneId === report.paneId);
    if (!crew) throw new Error('Not reported: this pane is not a working crew member.');
    this.deps.jobs.crewReported({
      ...report,
      jobId: crew.jobId,
      stepId: crew.stepId,
      label: crew.label
    });
    this.turns.set(crew.id, { reported: true, idle: 0 });
    return report.status === 'done'
      ? `Reported step ${crew.stepId} done to the Admiral. Stop now.`
      : `Sent your ${report.status === 'blocked' ? 'blocker' : 'question'} to the Admiral. Stop now; its answer arrives as your next prompt.`;
  }

  /**
   * A crew member's turn ended. One that reported first is waiting as it
   * should; one that did not is idle, and its Admiral hears of it.
   */
  turnEnded(sessionId: string): void {
    const crew = this.store.crew
      .live()
      .find((c) => c.sessionId === sessionId && c.status === CREW_LIVE);
    // The client drives it now: its turns are theirs, not idle ones.
    if (!crew || crew.flag === 'user-driven') return;
    const turn = this.turns.get(crew.id);
    if (turn?.reported === true) {
      this.turns.set(crew.id, { reported: false, idle: 0 });
      return;
    }
    const idle = (turn?.idle ?? 0) + 1;
    this.turns.set(crew.id, { reported: false, idle });
    this.deps.jobs.crewIdle({
      jobId: crew.jobId,
      stepId: crew.stepId,
      label: crew.label,
      idle,
      nudgeLimit: this.deps.nudgeLimit()
    });
  }

  /** A session reported from a pane: a crew member there is live, on that session. */
  reported(paneId: string, sessionId: string): void {
    const crew = this.store.crew.live().find((c) => c.paneId === paneId);
    if (!crew || (crew.status !== CREW_STARTING && crew.sessionId === sessionId)) return;
    this.store.crew.reported(crew.id, sessionId);
    this.flags.started(crew);
    this.touch(crew.jobId);
  }

  /**
   * A crew member's pane went away before Fleet stopped it. The member ends,
   * and a step it left running waits for the client's OK to hire again.
   */
  ended(paneId: string, how: CrewEnd): void {
    const crew = this.store.crew.live().find((c) => c.paneId === paneId);
    if (!crew) return;
    const note =
      how.kind === 'closed'
        ? 'was closed by you'
        : how.exitCode === 0
          ? 'ended on its own'
          : `ended with exit code ${how.exitCode}`;
    this.store.crew.end(crew.id, note);
    log.info('crew member ended', { crewId: crew.id, jobId: crew.jobId, how: how.kind });
    this.deps.jobs.crewLeft({
      jobId: crew.jobId,
      stepId: crew.stepId,
      status: how.kind === 'closed' || how.exitCode === 0 ? 'stopped' : 'failed',
      label: crew.label,
      note
    });
    this.touch(crew.jobId);
  }

  private requirePanes(): CrewPaneHost {
    if (this.deps.panes === null) throw new Error('Crew panes are not available in this Fleet.');
    return this.deps.panes;
  }

  /** The job crew act for, refused while its automatic turns are held at the chain limit. */
  private actingJob(jobId: number): AgencyJob {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`There is no job ${jobDisplayId(jobId)}.`);
    if (job.holds.includes('chain_limit')) {
      throw new Error(
        `Not done: ${jobDisplayId(jobId)} has run its automatic turns in a row, so crew acts wait until the client writes.`
      );
    }
    return job;
  }

  private limitKey(jobId: number): string {
    return `job:${jobId}`;
  }

  private checkRate(jobId: number): void {
    const refused = this.limiter.refusal(this.limitKey(jobId), this.deps.now());
    if (refused !== null) throw new Error(refused);
  }

  /** The last member a restart took from an interrupted step, which a hire resumes. */
  private lostMember(jobId: number, stepId: string): CrewRecord | null {
    const last = this.store.crew
      .all(jobId)
      .filter((c) => c.stepId === stepId)
      .at(-1);
    return last?.endReason === LOST_AT_RESTART &&
      last.sessionId !== null &&
      last.workspaceId !== null &&
      this.store.resources.workspaceRoot(last.workspaceId) !== null
      ? last
      : null;
  }

  private refOf(crew: CrewRecord): string {
    return crew.paneId === null ? crew.label : sessionRef(crew.paneId);
  }

  /** A live crew member of the job by its ref, label, pane or session id, that its flags let `act` reach. */
  private resolve(jobId: number, ref: string, act: CrewAct): CrewRecord {
    const needle = ref.trim().toLowerCase();
    const live = this.store.crew.live(jobId);
    const found = live.find(
      (c) =>
        c.label.toLowerCase() === needle ||
        (c.paneId !== null && (c.paneId === needle || sessionRef(c.paneId) === needle)) ||
        c.sessionId === needle
    );
    if (found) {
      const refused = this.flags.refusal(found, act);
      if (refused !== null) throw new Error(refused);
      return found;
    }
    const names = live.map((c) => `${c.label} (${this.refOf(c)})`).join(', ');
    throw new Error(
      `${jobDisplayId(jobId)} has no crew member working called "${ref.trim()}". ${names === '' ? 'None is working.' : `Working now: ${names}.`}`
    );
  }

  private record(
    job: AgencyJob,
    stepId: string,
    text: string,
    data: Record<string, unknown>
  ): void {
    this.store.plans.log({ jobId: job.id, kind: 'crew', stepId, text, data });
    this.deps.changed([{ repoId: job.repoId, jobId: job.id }]);
  }

  private touch(jobId: number): void {
    const job = this.store.getJob(jobId);
    if (job) this.deps.changed([{ repoId: job.repoId, jobId }]);
  }
}
