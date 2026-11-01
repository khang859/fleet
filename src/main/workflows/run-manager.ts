import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  agentChatHandle,
  type OpenAgentResult,
  ACTIVE_RUN_STATES,
  stagesOf,
  type BoardItem,
  type PlanAnswer,
  type PlanBuildMode,
  type RunAgent,
  type RunBranch,
  type RunOrigin,
  type RunReport,
  type RunTab,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowNotice,
  type WorkflowProgram,
  type WorkflowRun,
  type WorkflowStageDef
} from '../../shared/workflows';
import { createLogger } from '../logger';
import { agentCommandLine } from './agent-command';
import { Board, boardText, type NewItem } from './board';
import { isPersonInput } from './person-input';
import {
  agentBrief,
  PLAN_APPROVED_MESSAGE,
  reminderText,
  RETRY_MESSAGE,
  RETURN_MESSAGE,
  RUN_OVER_NOTE,
  START_MESSAGE,
  type BriefHandoff
} from './prompts';
import type { RunStore } from './run-store';
import {
  agentMode,
  agentsIn,
  currentStage,
  latestPlan,
  noWayOn,
  onlyWaitsForPerson,
  permissionModeOf,
  reportAgent,
  runsLast,
  skipsItself,
  stageOf,
  stageToStart
} from './stages';
import type { PaneKind } from './tools';

const log = createLogger('workflows:runs');

export const START_DEADLINE_MS = 2 * 60_000;
export const SILENCE_MS = 5 * 60_000;
export const PERSON_IDLE_MS = 5 * 60_000;
export const LIMIT_GRACE_MS = 10 * 60_000;
export const ADD_TIME_MS = 30 * 60_000;
export const DEFAULT_LIMIT_MS = 60 * 60_000;
/** A gap this long between two ticks can only be sleep, even with no suspend event. */
const SLEEP_GAP_MS = 60_000;

export type RunDeps = {
  store: RunStore;
  now: () => number;
  openPane: (pane: { paneId: string; cwd: string; line: string }) => Promise<void>;
  killPane: (paneId: string) => void;
  lastOutputAt: (paneId: string) => number;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  makeWorktree: (run: WorkflowRun, pinnedSha?: string) => Promise<{ path: string; sha: string }>;
  removeWorktree: (run: WorkflowRun) => Promise<void>;
  /** Make the worktree of a `new-branch` run, or open it again on the run's branch. */
  makeBranch: (run: WorkflowRun) => Promise<{ path: string; branch: RunBranch }>;
  /** The change so far, for read-only agents. */
  diffOf: (run: WorkflowRun) => Promise<string>;
  /** Answer a held Claude Code request with a mode or a reason. */
  answerRequest: (
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string,
    mode?: PlanBuildMode
  ) => boolean;
  onRun: (run: WorkflowRun) => void;
  onTab: (tab: RunTab) => void;
  notify: (notice: Omit<WorkflowNotice, 'id'>) => void;
  /** The run ended, with its report in place. */
  onEnded: (run: WorkflowRun) => void;
  maxAgents: () => number;
  devExtension: string | null;
  /** Parses the stored file of a run from an earlier launch. */
  parse: (text: string) => WorkflowDef;
};

/** What a start needs. The service checked all of it before it calls `create`. */
export type RunPlan = {
  workflowId: string;
  path: string;
  projectPath: string;
  def: WorkflowDef;
  bytes: string;
  hash: string;
  inputs: Record<string, string>;
  target: string;
  slug: string;
  origin: RunOrigin;
  ruleId: string | null;
  pr: WorkflowRun['pr'];
  locked: boolean;
  /** A team PR in a new worktree. Agents skip the trust question. */
  teamPr: boolean;
  focus: boolean;
};

export type PaneIdentity =
  | { kind: Extract<PaneKind, 'outside'> }
  | { kind: Extract<PaneKind, 'run' | 'last'>; runId: string; agentId: string }
  | { kind: Extract<PaneKind, 'builder'>; project: string; draftId: string | null }
  | { kind: 'old-attempt' };

type Located = { run: WorkflowRun; agent: RunAgent };

const PLAN_WAITS = 'Its plan waits for you.';
const TALK_WAITS = 'It waits for your answer.';

const OVER_STATES = new Set<RunAgent['state']>(['done', 'skipped']);
const LIVE_STATES = new Set<RunAgent['state']>(['starting', 'working', 'waiting']);

/** A person must act on this run. A run sets its state from this. */
export function needsPerson(run: WorkflowRun): boolean {
  if (run.problem !== null) return true;
  return run.agents.some((agent) => agent.state === 'failed' || agent.needsPerson || agent.silent);
}

/** A notice about a live run goes away when that run no longer fits it. */
export function noticeIsCurrent(notice: WorkflowNotice, run: WorkflowRun | undefined): boolean {
  if (run === undefined) return notice.kind !== 'needs-you' && notice.kind !== 'agent-start';
  switch (notice.kind) {
    case 'needs-you':
      return isActive(run) && needsPerson(run);
    case 'agent-start':
      return isActive(run);
    case 'queued':
      return run.state === 'queued';
    case 'limit':
      return isActive(run) && run.limitReachedAt !== null;
    case 'report-ready':
      return run.state !== 'closed';
    case 'info':
    case 'agent-create':
      return true;
  }
}

export function isActive(run: WorkflowRun): boolean {
  return ACTIVE_RUN_STATES.includes(run.state);
}

function newAgent(role: string, program: WorkflowProgram, isLast: boolean): RunAgent {
  return {
    id: randomUUID(),
    role,
    program,
    isLast,
    state: 'pending',
    paneId: null,
    attempt: 0,
    summary: null,
    note: null,
    reminded: false,
    needsPerson: false,
    silent: false,
    personTyped: false,
    keptPaneId: null,
    autoRetried: false,
    sessionId: null,
    transcriptPath: null,
    pendingPermission: null
  };
}

function stageAgent(def: WorkflowAgentDef, stage: number, isLast: boolean): RunAgent {
  const agent: RunAgent = { ...newAgent(def.role, def.program, isLast), stage, access: def.access };
  if (def.talks) agent.talks = true;
  if (def.plan) agent.plan = true;
  if (def.resume) agent.resumes = def.resume;
  return agent;
}

function runAgents(def: WorkflowDef): RunAgent[] {
  return stagesOf(def).flatMap((stage, index) =>
    stage.agents.map((agent) => stageAgent(agent, index, runsLast(def, index)))
  );
}

/** The report of a run as it stands. It always gives something to read. */
export function buildReport(run: WorkflowRun, why?: string): RunReport {
  const last = run.agents.find((agent) => agent.isLast);
  const speaker = reportAgent(run);
  if (speaker?.summary) {
    return { text: speaker.summary, incomplete: false, missing: [], savedTo: null, posted: false };
  }
  const missing = run.agents
    .filter((agent) => !agent.summary && agent.state !== 'skipped')
    .map((agent) => agent.role);
  const summaries = run.agents
    .filter((agent) => agent.summary)
    .map((agent) => `## ${agent.role}\n\n${agent.summary}`);
  if (!last && missing.length === 0 && summaries.length > 0) {
    return {
      text: summaries.join('\n\n'),
      incomplete: false,
      missing,
      savedTo: null,
      posted: false
    };
  }
  return {
    text: incompleteText(run, missing, summaries, why),
    incomplete: true,
    missing,
    savedTo: null,
    posted: false
  };
}

function incompleteText(
  run: WorkflowRun,
  missing: string[],
  summaries: string[],
  why?: string
): string {
  const items = run.board.filter((item) => item.mergedInto === undefined);
  const parts = ['# Incomplete report'];
  if (why) parts.push(why);
  if (missing.length > 0) parts.push(`These agents did not finish: ${missing.join(', ')}.`);
  parts.push(...summaries);
  if (items.length > 0) parts.push(`## Board\n\n${boardText(items)}`);
  if (summaries.length === 0 && items.length === 0) {
    parts.push('Nothing was finished or added to the board before the run ended.');
  }
  return parts.join('\n\n');
}

/** Owns each run: its agents, its board, and every move between states. */
export class WorkflowRunManager {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly boards = new Map<string, Board>();
  private readonly defs = new Map<string, WorkflowDef>();
  /** Runs whose tab opens in front. */
  private readonly focus = new Map<string, boolean>();
  /** Pane id to the agent in it. A pane leaves this map when it stops counting. */
  private readonly panes = new Map<string, { runId: string; agentId: string }>();
  /** Panes of older attempts. Their calls are refused. */
  private readonly oldPanes = new Set<string>();
  /** Runs that are opening an agent again. Two at once would fight over the worktree. */
  private readonly opening = new Set<string>();
  /** Runs that are opening a stage. Its agents are not yet all started. */
  private readonly openingStage = new Set<string>();
  private readonly startedAt = new Map<string, number>();
  /** Agents whose current turn a person started, by agent id. */
  private readonly personTurns = new Set<string>();
  private readonly lastTypedAt = new Map<string, number>();
  /** Silence is measured from here, so Keep waiting restarts the count. */
  private readonly silenceFrom = new Map<string, number>();
  private lastTick: number;
  private sleepingSince: number | null = null;

  constructor(private readonly deps: RunDeps) {
    this.lastTick = deps.now();
    for (const run of deps.store.loadAll()) this.adopt(run);
  }

  /** A run from an earlier launch. Fleet kills every PTY when it quits, so none are left. */
  private adopt(run: WorkflowRun): void {
    if (isActive(run)) {
      run.state = 'cut-off';
      for (const agent of run.agents) this.releaseAgent(agent);
      this.deps.store.save(run);
    }
    if (run.keptPanes.length > 0) {
      this.forgetKeptPanes(run);
      this.dropIdleWorktree(run);
      this.deps.store.save(run);
    }
    this.runs.set(run.id, run);
    this.boards.set(run.id, new Board(run.board));
  }

  private releaseAgent(agent: RunAgent): void {
    agent.paneId = null;
    agent.pendingPermission = null;
    // A Pi plan waits in a file, so it still waits after a restart. A Claude Code request dies.
    if (agent.program === 'claude') agent.pendingPlan = null;
    if (LIVE_STATES.has(agent.state)) {
      agent.state = 'failed';
      agent.note = 'Fleet closed during this run.';
    }
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()];
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  hasActive(): boolean {
    return this.list().some(isActive);
  }

  findActive(path: string, target: string): WorkflowRun | undefined {
    return this.list().find(
      (run) => isActive(run) && run.workflowPath === path && run.target === target
    );
  }

  /** What a pane is, for the bridge. */
  identify(paneId: string): PaneIdentity {
    if (this.oldPanes.has(paneId)) return { kind: 'old-attempt' };
    const pane = this.panes.get(paneId);
    if (!pane) return { kind: 'outside' };
    const located = this.locate(paneId);
    return {
      kind: located?.agent.isLast ? 'last' : 'run',
      runId: pane.runId,
      agentId: pane.agentId
    };
  }

  private locate(paneId: string): Located | null {
    const pane = this.panes.get(paneId);
    if (!pane) return null;
    const run = this.runs.get(pane.runId);
    const agent = run?.agents.find((a) => a.id === pane.agentId);
    return run && agent ? { run, agent } : null;
  }

  /** The agents that use room now, and those of a run that is opening them. */
  private activeAgents(): number {
    const count = (run: WorkflowRun): number => {
      const opening = run.state === 'preparing' || run.state === 'running';
      const toOpen = (agent: RunAgent): boolean =>
        opening && agent.state === 'pending' && stageOf(agent) === 0;
      return run.agents.filter((agent) => LIVE_STATES.has(agent.state) || toOpen(agent)).length;
    };
    return this.list()
      .filter(isActive)
      .reduce((total, run) => total + count(run), 0);
  }

  /** Make a run, and start it now or queue it behind the agent limit. */
  create(plan: RunPlan): WorkflowRun {
    const run = this.newRun(plan);
    this.deps.store.create(run.id, plan.bytes);
    this.runs.set(run.id, run);
    this.boards.set(run.id, new Board());
    this.defs.set(run.id, plan.def);
    this.focus.set(run.id, plan.focus);
    this.commit(run);
    this.drainQueue();
    return run;
  }

  private newRun(plan: RunPlan): WorkflowRun {
    const { def } = plan;
    return {
      id: randomUUID(),
      workflowId: plan.workflowId,
      workflowName: def.name,
      workflowPath: plan.path,
      projectPath: plan.projectPath,
      hash: plan.hash,
      inputs: plan.inputs,
      target: plan.target,
      slug: plan.slug,
      origin: plan.origin,
      ruleId: plan.ruleId,
      state: 'queued',
      createdAt: this.deps.now(),
      endedAt: null,
      cwd: plan.projectPath,
      worktreePath: null,
      pr: plan.pr,
      locked: plan.locked,
      problem: null,
      usesBoard: def.board,
      finish: def.finish ?? null,
      agents: runAgents(def),
      board: [],
      report: null,
      activeMs: 0,
      limitMs: DEFAULT_LIMIT_MS,
      limitReachedAt: null,
      sleptMs: 0,
      keptPanes: [],
      teamPr: plan.teamPr,
      stages: stagesOf(def).map((stage) => stage.name),
      ...(def.stages ? { stageFile: true } : {})
    };
  }

  /** Start queued runs, oldest first, while the agent limit has room. */
  private drainQueue(): void {
    for (const run of this.list()) {
      if (run.state !== 'queued') continue;
      const needed = agentsIn(run, 0).length;
      const room = this.activeAgents() + needed <= this.deps.maxAgents();
      if (room || this.activeAgents() === 0) {
        void this.launch(run);
        continue;
      }
      if (run.problem === null) {
        run.problem = `Waiting for room: Fleet runs ${this.deps.maxAgents()} agents at once.`;
        this.deps.notify({
          kind: 'queued',
          text: `${run.workflowName} waits. ${run.problem}`,
          runId: run.id,
          projectPath: run.projectPath
        });
        this.commit(run);
      }
      return;
    }
  }

  private async launch(run: WorkflowRun): Promise<void> {
    run.state = 'preparing';
    run.problem = null;
    this.commit(run);
    const ready = await this.prepareWorktree(run);
    // A person can stop the run during either wait.
    if (!ready || !isActive(run)) return;
    run.state = 'running';
    await this.openStage(run, 0);
    this.settle(run);
  }

  /** Start each agent of a stage. A settle during this wait must not start them too. */
  private async openStage(run: WorkflowRun, stage: number): Promise<void> {
    this.openingStage.add(run.id);
    try {
      await this.writeHandoff(run, stage);
      for (const agent of agentsIn(run, stage)) {
        if (agent.state === 'pending' && isActive(run)) await this.startAgent(run, agent, false);
      }
    } finally {
      this.openingStage.delete(run.id);
    }
  }

  /** Read-only agents have no shell, so Fleet writes the change where they can read it. */
  private async writeHandoff(run: WorkflowRun, stage: number): Promise<void> {
    const readers = agentsIn(run, stage).some((agent) => agent.access === 'read');
    if (stage === 0 || !readers) return;
    try {
      this.deps.store.writeDiff(run.id, await this.deps.diffOf(run));
    } catch (err) {
      log.warn('the change diff was not written', { runId: run.id, error: String(err) });
    }
  }

  /** Make the worktree a PR run asks for. Answers false when it failed. */
  private async prepareWorktree(run: WorkflowRun): Promise<boolean> {
    if (run.worktreePath || !this.usesWorktree(run)) return true;
    try {
      await this.openWorktree(run);
      // A person can stop or close the run during the wait. No agent used it, so it goes.
      if (!isActive(run)) this.dropWorktree(run);
      this.commit(run);
      return isActive(run);
    } catch (err) {
      if (isActive(run)) {
        run.state = 'needs-you';
        run.problem = `The worktree failed: ${err instanceof Error ? err.message : String(err)}`;
        this.commit(run);
      }
      return false;
    }
  }

  private usesWorktree(run: WorkflowRun): boolean {
    const { workspace } = this.defOf(run);
    return workspace === 'new-branch' || (workspace === 'pr-worktree' && run.pr !== null);
  }

  private async openWorktree(run: WorkflowRun): Promise<void> {
    if (this.defOf(run).workspace === 'new-branch') {
      const { path, branch } = await this.deps.makeBranch(run);
      run.branch = branch;
      this.useWorktree(run, path);
    } else if (run.pr) {
      const worktree = await this.deps.makeWorktree(run);
      run.pr = { ...run.pr, headSha: worktree.sha };
      this.useWorktree(run, worktree.path);
    }
  }

  private useWorktree(run: WorkflowRun, path: string): void {
    run.worktreePath = path;
    run.cwd = path;
  }

  /** Try the worktree again, after a failed start. */
  retryPrepare(runId: string): void {
    const run = this.runs.get(runId);
    if (run?.state !== 'needs-you' || !run.problem || run.worktreePath) return;
    void this.launch(run);
  }

  private briefPath(run: WorkflowRun, agent: RunAgent): string {
    return this.deps.store.writePrompt(run.id, `${agent.id}.md`, this.briefOf(run, agent));
  }

  private briefOf(run: WorkflowRun, agent: RunAgent): string {
    const def = this.defOf(run);
    const source = stagesOf(def)[stageOf(agent)]?.agents.find(
      (candidate) => candidate.role === agent.role
    );
    return agentBrief(
      run,
      def,
      {
        role: agent.role,
        program: agent.program,
        prompt: source?.prompt ?? '',
        isLast: agent.isLast,
        access: agent.access,
        talks: agent.talks,
        plan: agent.plan && !agent.planApproved
      },
      this.handoffOf(run, agent)
    );
  }

  /** What earlier stages left for this agent. */
  private handoffOf(run: WorkflowRun, agent: RunAgent): BriefHandoff {
    if (!run.stageFile || stageOf(agent) === 0) return {};
    const diffPath = this.deps.store.diffPath(run.id);
    return {
      planPath: latestPlan(run)?.path,
      diffPath: agent.access === 'read' && existsSync(diffPath) ? diffPath : undefined
    };
  }

  /** The workflow as approved. It comes from the run's own copy, never from the repo. */
  private defOf(run: WorkflowRun): WorkflowDef {
    const def = this.defs.get(run.id);
    if (!def) throw new Error(`Run ${run.id} has no stored workflow.`);
    return def;
  }

  /** The session a start goes on with: its own, or that of the agent it comes back as. */
  private handleFor(run: WorkflowRun, agent: RunAgent, resume: boolean): string | null {
    const own = resume ? agentChatHandle(agent) : null;
    return own ?? this.namedHandle(run, agent);
  }

  private namedHandle(run: WorkflowRun, agent: RunAgent): string | null {
    const named = run.agents.filter(
      (other) => other.role === agent.resumes && stageOf(other) < stageOf(agent)
    );
    return named.map(agentChatHandle).findLast((handle) => handle !== null) ?? null;
  }

  /** One session has one program running it, so the agent it comes back from must stop. */
  private retireNamedPanes(run: WorkflowRun, agent: RunAgent): void {
    if (!agent.resumes) return;
    for (const other of run.agents) {
      if (other.role === agent.resumes && other !== agent) this.retirePane(other);
    }
  }

  /** Fixed words from Fleet. They never hold TOML or input text. */
  private messageOf(agent: RunAgent, resume: boolean, handle: string | null): string {
    if (resume) return RETRY_MESSAGE;
    return agent.resumes && handle ? RETURN_MESSAGE : START_MESSAGE;
  }

  /** The line that starts or resumes an agent. */
  private commandOf(
    run: WorkflowRun,
    agent: RunAgent,
    start: { briefPath: string; message: string | null; resume: string | null }
  ): string {
    const def = this.defOf(run);
    const inStageFile = def.stages !== undefined;
    return agentCommandLine({
      ...start,
      program: agent.program,
      mode: agentMode(run, def, agent),
      devExtension: agent.program === 'pi' ? this.deps.devExtension : null,
      addDir:
        inStageFile && agent.program === 'claude' ? this.deps.store.folder(run.id) : undefined,
      talks: agent.talks,
      permissionMode: inStageFile ? permissionModeOf(run, agent) : undefined
    });
  }

  private async startAgent(
    run: WorkflowRun,
    agent: RunAgent,
    resume: boolean,
    message?: string
  ): Promise<void> {
    this.retirePane(agent);
    this.retireNamedPanes(run, agent);
    const paneId = randomUUID();
    agent.paneId = paneId;
    agent.attempt += 1;
    agent.state = 'starting';
    agent.note = null;
    agent.reminded = false;
    agent.needsPerson = false;
    agent.silent = false;
    this.personTurns.delete(agent.id);
    this.panes.set(paneId, { runId: run.id, agentId: agent.id });
    this.startedAt.set(agent.id, this.deps.now());
    this.silenceFrom.set(agent.id, this.deps.now());

    const handle = this.handleFor(run, agent, resume);
    const line = this.commandOf(run, agent, {
      briefPath: this.briefPath(run, agent),
      message: message ?? this.messageOf(agent, resume, handle),
      resume: handle
    });
    // A pane takes time to open, and the page shows the new state during that wait.
    this.commit(run);
    try {
      await this.deps.openPane({ paneId, cwd: run.cwd, line });
      // Stopped or replaced while it opened, so the kill came too soon to find it.
      if (agent.paneId !== paneId) this.deps.killPane(paneId);
      this.emitTab(run);
    } catch (err) {
      this.failAgent(run, agent, `The pane did not open: ${String(err)}`, false);
    }
    this.commit(run);
  }

  /** Stop counting an agent's old pane, and refuse anything it still sends. */
  private retirePane(agent: RunAgent): void {
    if (agent.paneId === null) return;
    this.oldPanes.add(agent.paneId);
    this.dropPane(agent.paneId);
    agent.paneId = null;
  }

  private dropPane(paneId: string): void {
    this.panes.delete(paneId);
    this.deps.killPane(paneId);
  }

  private failAgent(run: WorkflowRun, agent: RunAgent, note: string, retry: boolean): void {
    agent.state = 'failed';
    agent.note = note;
    agent.pendingPermission = null;
    if (retry && !agent.autoRetried) {
      agent.autoRetried = true;
      void this.startAgent(run, agent, true);
      return;
    }
    this.deps.notify({
      kind: 'needs-you',
      text: `${run.workflowName}: ${agent.role} needs you. ${note}`,
      runId: run.id,
      projectPath: run.projectPath
    });
  }

  // --- Signals from panes ---

  onSessionStart(paneId: string, session: { id: string; transcriptPath: string | null }): void {
    const located = this.locate(paneId);
    if (!located) return;
    located.agent.sessionId = session.id;
    located.agent.transcriptPath = session.transcriptPath;
    if (located.agent.state === 'starting') {
      located.agent.state = 'working';
      located.agent.needsPerson = false;
      located.agent.note = null;
    }
    this.settle(located.run);
  }

  onTurnStart(paneId: string): void {
    const located = this.locate(paneId);
    if (!located) return;
    const { agent, run } = located;
    if (agent.state === 'waiting' || agent.state === 'starting') agent.state = 'working';
    agent.needsPerson = false;
    agent.pendingPermission = null;
    // A new Claude Code turn means that the plan request is over. A Pi plan waits in Fleet.
    if (agent.program === 'claude') agent.pendingPlan = null;
    this.settle(run);
  }

  /** A turn ended. Answers the text of a reminder, when Fleet must send one. */
  onTurnEnd(paneId: string): string | null {
    const located = this.locate(paneId);
    if (!located) return null;
    const { agent, run } = located;
    if (agent.state !== 'working') return null;

    if (agent.talks || agent.pendingPlan) {
      this.personTurns.delete(agent.id);
      this.waitForPerson(run, agent, agent.pendingPlan ? PLAN_WAITS : TALK_WAITS);
      return null;
    }
    if (this.personTurns.delete(agent.id)) {
      agent.state = 'waiting';
      this.settle(run);
      return null;
    }
    if (agent.reminded) {
      agent.state = 'waiting';
      agent.needsPerson = true;
      agent.note = 'It stopped with no finish call, after one reminder.';
      this.notifyNeedsYou(run, agent);
      this.settle(run);
      return null;
    }
    agent.reminded = true;
    this.commit(run);
    return reminderText(agent.program);
  }

  private waitForPerson(run: WorkflowRun, agent: RunAgent, note: string): void {
    agent.state = 'waiting';
    agent.needsPerson = true;
    agent.note = note;
    this.notifyNeedsYou(run, agent);
    this.settle(run);
  }

  /** A Claude Code agent waits on its question dialog. No Stop event comes for this. */
  onQuestion(paneId: string): void {
    const located = this.locate(paneId);
    if (located?.agent.state !== 'working') return;
    this.waitForPerson(located.run, located.agent, 'It asks you a question.');
  }

  private notifyNeedsYou(run: WorkflowRun, agent: RunAgent): void {
    this.deps.notify({
      kind: 'needs-you',
      text: `${run.workflowName}: ${agent.role} needs you.`,
      runId: run.id,
      projectPath: run.projectPath,
      planAgentId: agent.pendingPlan ? agent.id : undefined
    });
  }

  onApiFailure(paneId: string, message: string): void {
    const located = this.locate(paneId);
    // A follow-up turn after the finish call changes nothing about the run.
    if (!located || !isActive(located.run) || !LIVE_STATES.has(located.agent.state)) return;
    this.failAgent(located.run, located.agent, message, true);
    this.settle(located.run);
  }

  onPermission(paneId: string, toolUseId: string | null, tool: string, plan?: string): void {
    const located = this.locate(paneId);
    if (located?.agent.state !== 'working') return;
    const { agent, run } = located;
    if (agent.plan && plan !== undefined) {
      this.savePlan(run, agent, plan, toolUseId);
      this.waitForPerson(run, agent, PLAN_WAITS);
      return;
    }
    agent.state = 'waiting';
    agent.needsPerson = true;
    agent.note = `It asks to use ${tool}.`;
    agent.pendingPermission = toolUseId ? { toolUseId, tool } : null;
    this.notifyNeedsYou(run, agent);
    this.settle(run);
  }

  /** Save the plan first, so an answer given anywhere still leaves it readable. */
  private savePlan(
    run: WorkflowRun,
    agent: RunAgent,
    text: string,
    toolUseId: string | null
  ): void {
    const version = run.agents.flatMap((other) => other.plans ?? []).length + 1;
    const path = this.deps.store.writePlan(run.id, version, text);
    agent.plans = [...(agent.plans ?? []), { version, path, at: this.deps.now() }];
    agent.pendingPlan = { version, toolUseId };
  }

  readPlan(runId: string, version: number): string | null {
    return this.deps.store.readPlan(runId, version);
  }

  /** The tool call of a Pi plan. Answers why it is refused, or null. */
  submitPlan(runId: string, agentId: string, text: string): string | null {
    const located = this.located(runId, agentId);
    if (!located) return 'This pane is not in a run.';
    const { run, agent } = located;
    if (!agent.plan || agent.program !== 'pi') return 'This agent sends no plan to Fleet.';
    if (agent.planApproved) return 'A person already approved your plan.';
    this.savePlan(run, agent, text, null);
    this.commit(run);
    return null;
  }

  /** The tool of a plan ran, so a person approved it in the pane or in Copilot. */
  onToolDone(paneId: string, tool: string | undefined): void {
    const located = this.locate(paneId);
    if (tool !== 'ExitPlanMode' || !located?.agent.plan) return;
    located.agent.planApproved = true;
    located.agent.pendingPlan = null;
    this.settle(located.run);
  }

  /** A person answered on the plan page. Answers whether it reached the agent. */
  async answerPlan(runId: string, agentId: string, answer: PlanAnswer): Promise<boolean> {
    const located = this.actionable(runId, agentId);
    const plan = located?.agent.pendingPlan;
    if (!located || !plan) return false;
    if (located.agent.program === 'claude') return this.answerClaudePlan(located, plan, answer);
    return this.answerPiPlan(located, answer);
  }

  private answerClaudePlan(
    { run, agent }: Located,
    plan: { toolUseId: string | null },
    answer: PlanAnswer
  ): boolean {
    const approved = answer.kind === 'approve';
    const answered = approved
      ? this.deps.answerRequest(plan.toolUseId ?? '', 'allow', undefined, answer.mode)
      : this.deps.answerRequest(plan.toolUseId ?? '', 'deny', answer.text);
    agent.pendingPlan = null;
    agent.pendingPermission = null;
    if (answered) {
      agent.planApproved = approved;
      if (approved) agent.buildMode = answer.mode;
      this.backToWork(agent);
    }
    this.settle(run);
    return answered;
  }

  private backToWork(agent: RunAgent): void {
    agent.state = 'working';
    agent.needsPerson = false;
    agent.note = null;
  }

  /** Pi has no write tools in this process, so approval opens a new one on the session. */
  private async answerPiPlan({ run, agent }: Located, answer: PlanAnswer): Promise<boolean> {
    agent.pendingPlan = null;
    if (answer.kind === 'approve') {
      agent.planApproved = true;
      await this.startAgent(run, agent, true, PLAN_APPROVED_MESSAGE);
      this.settle(run);
      return true;
    }
    if (!agent.sessionId) return false;
    this.backToWork(agent);
    this.settle(run);
    await this.deps.sendPrompt(agent.sessionId, answer.text);
    return true;
  }

  /** A person answered on the run page, so the agent has no question left. */
  onPermissionAnswered(toolUseId: string): void {
    const asks = (agent: RunAgent): boolean => agent.pendingPermission?.toolUseId === toolUseId;
    const run = this.list().find((candidate) => candidate.agents.some(asks));
    const agent = run?.agents.find(asks);
    if (!run || !agent) return;
    agent.pendingPermission = null;
    agent.state = 'working';
    agent.needsPerson = false;
    agent.note = null;
    this.settle(run);
  }

  /** A person typed in a pane. Enter sends a turn, so that turn is theirs. */
  onPersonInput(paneId: string, data: string): void {
    if (!isPersonInput(data)) return;
    const located = this.locate(paneId);
    if (!located) return;
    const { agent, run } = located;
    if (!agent.personTyped) {
      agent.personTyped = true;
      this.commit(run);
    }
    this.lastTypedAt.set(agent.id, this.deps.now());
    if (data.includes('\r')) this.personTurns.add(agent.id);
  }

  /** A PTY ended. `killed` means that it did not exit by itself. */
  onPaneClosed(paneId: string, killed: boolean): void {
    this.oldPanes.delete(paneId);
    const pane = this.panes.get(paneId);
    if (pane) this.onCountedPaneClosed(paneId, pane, killed);
    else this.onKeptPaneClosed(paneId);
  }

  private onCountedPaneClosed(
    paneId: string,
    pane: { runId: string; agentId: string },
    killed: boolean
  ): void {
    const run = this.runs.get(pane.runId);
    this.panes.delete(paneId);
    if (!run) return;
    const agent = run.agents.find((candidate) => candidate.id === pane.agentId);
    if (!agent) return;
    agent.paneId = null;
    this.emitTab(run);
    if (!isActive(run) || OVER_STATES.has(agent.state) || agent.state === 'failed') {
      this.commit(run);
      return;
    }
    // A pane that a person closed is not lost. They chose it, so Fleet does not retry.
    const note = killed ? 'A person closed its pane.' : 'Its pane exited.';
    this.failAgent(run, agent, note, !killed);
    this.settle(run);
  }

  private onKeptPaneClosed(paneId: string): void {
    const run = this.list().find((candidate) => candidate.keptPanes.includes(paneId));
    if (!run) return;
    run.keptPanes = run.keptPanes.filter((kept) => kept !== paneId);
    const agent = run.agents.find((candidate) => candidate.keptPaneId === paneId);
    if (agent) agent.keptPaneId = null;
    this.dropIdleWorktree(run);
    this.emitTab(run);
    this.commit(run);
  }

  // --- Tools ---

  private located(runId: string, agentId: string): Located | null {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((candidate) => candidate.id === agentId);
    return run && agent ? { run, agent } : null;
  }

  private persistItem(run: WorkflowRun, item: BoardItem): void {
    this.deps.store.appendBoard(run.id, item);
  }

  private boardOf(runId: string, agentId: string): Located & { board: Board } {
    const located = this.located(runId, agentId);
    const board = this.boards.get(runId);
    if (!located || !board) throw new Error('This pane is not in a run.');
    return { ...located, board };
  }

  private publishBoard(run: WorkflowRun, board: Board): void {
    run.board = board.all();
    this.deps.onRun(run);
  }

  addFinding(runId: string, agentId: string, item: NewItem): ReturnType<Board['add']> {
    const { run, agent, board } = this.boardOf(runId, agentId);
    const result = board.add(agent.role, item);
    if (result.added) {
      this.persistItem(run, result.item);
      this.publishBoard(run, board);
    }
    return result;
  }

  listFindings(runId: string): BoardItem[] {
    return this.boards.get(runId)?.list() ?? [];
  }

  mergeFindings(runId: string, agentId: string, ids: string[], item: NewItem): BoardItem {
    const { run, agent, board } = this.boardOf(runId, agentId);
    const merged = board.merge(agent.role, ids, item);
    for (const id of ids) {
      const source = board.get(id);
      if (source) this.persistItem(run, source);
    }
    this.persistItem(run, merged);
    this.publishBoard(run, board);
    return merged;
  }

  /** A finish call. Answers why it is refused, or null. */
  finishAgent(runId: string, agentId: string, summary: string): string | null {
    const located = this.located(runId, agentId);
    if (!located) return 'This pane is not in a run.';
    const { run, agent } = located;
    if (summary.trim() === '') return 'The summary is empty.';
    if (agent.state === 'done')
      return 'You already finished. Follow-up turns do not change the report.';
    if (!isActive(run)) return 'This run has ended.';
    if (agent.plan && !agent.planApproved) return 'A person must approve your plan first.';
    agent.summary = summary;
    agent.state = 'done';
    agent.note = null;
    agent.needsPerson = false;
    this.settle(run);
    return null;
  }

  // --- Actions from a person ---

  /** The agent, while its run can still take an action from a person. */
  private actionable(runId: string, agentId: string): Located | null {
    const located = this.located(runId, agentId);
    return located && isActive(located.run) ? located : null;
  }

  async retry(runId: string, agentId: string): Promise<void> {
    const located = this.actionable(runId, agentId);
    if (!located) return;
    await this.startAgent(located.run, located.agent, agentChatHandle(located.agent) !== null);
    this.settle(located.run);
  }

  skip(runId: string, agentId: string): void {
    const located = this.actionable(runId, agentId);
    if (!located) return;
    const { run, agent } = located;
    this.retirePane(agent);
    agent.state = 'skipped';
    agent.pendingPermission = null;
    agent.needsPerson = false;
    agent.note = null;
    this.emitTab(run);
    this.settle(run);
  }

  /** Keep waiting for a silent agent: the count starts again from now. */
  keepWaiting(runId: string, agentId: string): void {
    const located = this.actionable(runId, agentId);
    if (!located) return;
    located.agent.silent = false;
    this.silenceFrom.set(agentId, this.deps.now());
    this.settle(located.run);
  }

  addTime(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.limitMs = Math.max(run.limitMs, run.activeMs) + ADD_TIME_MS;
    run.limitReachedAt = null;
    this.commit(run);
  }

  stop(runId: string, why = 'A person stopped this run.'): void {
    const run = this.runs.get(runId);
    if (!run || !isActive(run)) return;
    for (const agent of run.agents) this.stopAgent(agent);
    run.report = buildReport(run, why);
    run.state = 'stopped';
    run.endedAt = this.deps.now();
    this.emitTab(run);
    this.commit(run);
    this.deps.onEnded(run);
  }

  private stopAgent(agent: RunAgent): void {
    if (agent.paneId !== null) {
      const paneId = agent.paneId;
      this.panes.delete(paneId);
      agent.paneId = null;
      this.deps.killPane(paneId);
    }
    agent.pendingPermission = null;
    if (!OVER_STATES.has(agent.state) && agent.state !== 'pending') agent.state = 'failed';
  }

  /** Its agent lives on, and it must not read as a pane outside any run. */
  private keepPane(run: WorkflowRun, agent: RunAgent, paneId: string): void {
    run.keptPanes.push(paneId);
    agent.keptPaneId = paneId;
    this.oldPanes.add(paneId);
  }

  /** Open a stopped agent again on its old chat. The run itself stays over. */
  async openAgent(runId: string, agentId: string): Promise<OpenAgentResult> {
    const found = this.located(runId, agentId);
    if (!found || isActive(found.run) || found.run.state === 'cut-off') {
      return { ok: false, reason: 'This run is not over yet.' };
    }
    const { run, agent } = found;
    if (agent.keptPaneId) return { ok: true, paneId: agent.keptPaneId };
    const resume = agentChatHandle(agent);
    if (!resume) return { ok: false, reason: 'This agent has no chat to open.' };
    if (this.opening.has(run.id)) return { ok: false, reason: 'Another agent is opening.' };

    this.opening.add(run.id);
    try {
      this.restoreDef(run);
      await this.restoreWorktree(run);
      return { ok: true, paneId: await this.openKeptPane(run, agent, resume) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.opening.delete(run.id);
    }
  }

  /** The chat needs its old folder, on the commit that the agent saw. */
  private async restoreWorktree(run: WorkflowRun): Promise<void> {
    if (run.worktreePath) return;
    if (run.branch) {
      this.useWorktree(run, (await this.deps.makeBranch(run)).path);
    } else if (run.pr && this.defOf(run).workspace === 'pr-worktree') {
      this.useWorktree(run, (await this.deps.makeWorktree(run, run.pr.headSha)).path);
    }
  }

  private async openKeptPane(run: WorkflowRun, agent: RunAgent, resume: string): Promise<string> {
    const paneId = randomUUID();
    const brief = `${this.briefOf(run, agent)}\n\n${RUN_OVER_NOTE}`;
    const line = this.commandOf(run, agent, {
      briefPath: this.deps.store.writePrompt(run.id, `${agent.id}-open.md`, brief),
      message: null,
      resume
    });
    this.keepPane(run, agent, paneId);
    this.focus.set(run.id, true);
    try {
      await this.deps.openPane({ paneId, cwd: run.cwd, line });
    } catch (err) {
      this.onKeptPaneClosed(paneId);
      throw err;
    }
    this.emitTab(run);
    this.commit(run);
    return paneId;
  }

  /** Go on with a cut-off run: each unfinished agent starts again on its old transcript. */
  async goOn(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run?.state !== 'cut-off') return;
    run.state = 'running';
    run.endedAt = null;
    run.problem = null;
    this.restoreDef(run);
    this.commit(run);
    // The cut can come before the worktree exists, or between two agents.
    if (!(await this.prepareWorktree(run))) return;
    await this.restartAgents(run);
    this.settle(run);
  }

  /** Each failed agent goes on from its transcript, and its stage's waiting agents start. */
  private async restartAgents(run: WorkflowRun): Promise<void> {
    const current = currentStage(run, stagesOf(this.defOf(run)));
    this.openingStage.add(run.id);
    try {
      if (current !== null) await this.writeHandoff(run, current);
      for (const agent of run.agents) {
        // A person can stop the run while a pane opens.
        if (!isActive(run)) break;
        if (agent.state === 'failed') await this.startAgent(run, agent, true);
        const waits = agent.state === 'pending' && stageOf(agent) === current;
        if (waits) await this.startAgent(run, agent, false);
      }
    } finally {
      this.openingStage.delete(run.id);
    }
  }

  private restoreDef(run: WorkflowRun): void {
    if (this.defs.has(run.id)) return;
    this.defs.set(run.id, this.deps.parse(this.deps.store.workflowBytes(run.id)));
    this.focus.set(run.id, true);
  }

  /** Close a run. Its panes close too, and the worktree goes only when asked. */
  close(runId: string, removeWorktree: boolean): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (isActive(run)) this.stop(runId);
    for (const agent of run.agents) this.stopAgent(agent);
    for (const paneId of run.keptPanes) this.deps.killPane(paneId);
    this.forgetKeptPanes(run);
    if (removeWorktree) this.dropWorktree(run);
    run.state = 'closed';
    this.emitTab(run);
    this.commit(run);
  }

  private forgetKeptPanes(run: WorkflowRun): void {
    run.keptPanes = [];
    for (const agent of run.agents) agent.keptPaneId = null;
  }

  /** A branch run keeps its worktree: it can hold work that nobody committed yet. */
  private dropIdleWorktree(run: WorkflowRun): void {
    if (run.keptPanes.length === 0 && !run.branch) this.dropWorktree(run);
  }

  private dropWorktree(run: WorkflowRun): void {
    if (!run.worktreePath) return;
    void this.deps.removeWorktree(run).catch((err: unknown) => {
      log.warn('a run worktree was not removed', { runId: run.id, error: String(err) });
    });
    run.worktreePath = null;
    run.cwd = run.projectPath;
  }

  /** An `open-pr` run opened its PR, so its committed work is safe and the worktree can go. */
  notePrOpened(runId: string, pr: { number: number; url: string }): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.openedPr = pr;
    delete run.prProblem;
    if (run.keptPanes.length === 0) this.dropWorktree(run);
    this.commit(run);
  }

  notePrProblem(runId: string, problem: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.prProblem = problem;
    this.commit(run);
    this.deps.notify({
      kind: 'info',
      text: `${run.workflowName}: no pull request. ${problem}`,
      runId: run.id,
      projectPath: run.projectPath
    });
  }

  /** Note where a report went: a file, or the PR. */
  updateReport(runId: string, change: Pick<Partial<RunReport>, 'savedTo' | 'posted'>): void {
    const run = this.runs.get(runId);
    if (!run?.report) return;
    run.report = { ...run.report, ...change };
    this.commit(run);
  }

  /** The PR got a new commit, so the findings are for an old one. */
  noteMovedOn(runId: string, headSha: string): void {
    const run = this.runs.get(runId);
    if (!run?.pr || run.pr.headSha === headSha) return;
    run.pr = { ...run.pr, movedOn: true };
    this.commit(run);
  }

  /** Quit: every active run is cut off, before the PTYs die. */
  markCutOff(): void {
    for (const run of this.list().filter(isActive)) {
      run.state = 'cut-off';
      for (const agent of run.agents) {
        if (agent.paneId !== null) this.panes.delete(agent.paneId);
        this.releaseAgent(agent);
      }
      this.deps.store.save(run);
    }
  }

  // --- Sleep ---

  suspend(): void {
    this.sleepingSince = this.deps.now();
  }

  resume(): void {
    if (this.sleepingSince === null) return;
    const gap = this.deps.now() - this.sleepingSince;
    this.sleepingSince = null;
    this.lastTick = this.deps.now();
    for (const run of this.list().filter(isActive)) {
      this.skipSleep(run, gap);
      this.commit(run);
    }
  }

  /** Sleep counts toward nothing that can fail an agent or stop a run. */
  private skipSleep(run: WorkflowRun, gap: number): void {
    run.sleptMs += gap;
    if (run.limitReachedAt !== null) run.limitReachedAt += gap;
    for (const agent of run.agents) {
      const started = this.startedAt.get(agent.id);
      if (started !== undefined) this.startedAt.set(agent.id, started + gap);
      this.silenceFrom.set(agent.id, this.deps.now());
      if (this.lastTypedAt.has(agent.id)) this.lastTypedAt.set(agent.id, this.deps.now());
    }
  }

  // --- The clock ---

  /** One reading of the clock: deadlines, silence, limits and the queue. */
  tick(): void {
    if (this.sleepingSince !== null) return;
    const now = this.deps.now();
    const delta = now - this.lastTick;
    this.lastTick = now;
    for (const run of this.list().filter(isActive)) {
      this.countTime(run, delta);
      for (const agent of run.agents) this.watchAgent(run, agent, now);
      this.watchLimit(run, now);
      if (isActive(run)) this.settle(run);
    }
    this.drainQueue();
  }

  private countTime(run: WorkflowRun, delta: number): void {
    if (delta >= SLEEP_GAP_MS) this.skipSleep(run, delta);
    else if (onlyWaitsForPerson(run)) this.pauseLimit(run, delta);
    else if (run.state !== 'queued') run.activeMs += delta;
  }

  /** The grace time after a limit waits too, so a slow answer never stops a run. */
  private pauseLimit(run: WorkflowRun, delta: number): void {
    if (run.limitReachedAt !== null) run.limitReachedAt += delta;
  }

  private watchAgent(run: WorkflowRun, agent: RunAgent, now: number): void {
    if (agent.state === 'starting') {
      const late = now - (this.startedAt.get(agent.id) ?? now) >= START_DEADLINE_MS;
      if (late && !agent.needsPerson) this.onLateStart(run, agent);
      return;
    }
    if (agent.state === 'working' && agent.paneId !== null) {
      const from = Math.max(
        this.deps.lastOutputAt(agent.paneId),
        this.silenceFrom.get(agent.id) ?? 0
      );
      agent.silent = now - from >= SILENCE_MS;
      return;
    }
    if (agent.state === 'waiting' && !agent.needsPerson) {
      const typed = this.lastTypedAt.get(agent.id) ?? now;
      if (now - typed >= PERSON_IDLE_MS) {
        agent.needsPerson = true;
        agent.note = 'It waits for you.';
      }
    }
  }

  /** A program can stop at its own question, such as whether to trust a folder. */
  private onLateStart(run: WorkflowRun, agent: RunAgent): void {
    if (run.origin === 'automatic') {
      this.failAgent(run, agent, 'It did not start in time.', false);
      return;
    }
    agent.needsPerson = true;
    agent.note = 'It has not started. Open its pane: it may ask you a question.';
    this.notifyNeedsYou(run, agent);
  }

  private watchLimit(run: WorkflowRun, now: number): void {
    if (run.activeMs < run.limitMs) return;
    if (run.origin === 'automatic') {
      this.stop(run.id, 'The run reached its time limit.');
      return;
    }
    if (run.limitReachedAt === null) {
      run.limitReachedAt = now;
      this.deps.notify({
        kind: 'limit',
        text: `${run.workflowName} reached its time limit.`,
        runId: run.id,
        projectPath: run.projectPath
      });
      return;
    }
    if (now - run.limitReachedAt >= LIMIT_GRACE_MS) {
      this.stop(run.id, 'The run reached its time limit, and nobody added time.');
    }
  }

  // --- Moves ---

  /** Work out what follows from the agent states, and save the run. */
  private settle(run: WorkflowRun): void {
    if (!isActive(run) || run.state === 'queued' || run.state === 'preparing') {
      this.commit(run);
      return;
    }
    const stages = stagesOf(this.defOf(run));
    this.startNextStage(run, stages);
    if (run.agents.every((agent) => OVER_STATES.has(agent.state))) {
      this.finish(run);
      return;
    }
    if (noWayOn(run, stages)) {
      this.finish(run);
      return;
    }
    run.state = needsPerson(run) ? 'needs-you' : 'running';
    this.commit(run);
  }

  private startNextStage(run: WorkflowRun, stages: WorkflowStageDef[]): void {
    if (this.openingStage.has(run.id) || noWayOn(run, stages)) return;
    // A failed worktree waits for a person to try it again.
    if (this.usesWorktree(run) && !run.worktreePath) return;
    const index = stageToStart(run, stages);
    if (index === null) return;
    if (skipsItself(run, stages[index])) {
      this.skipStage(run, index);
      this.startNextStage(run, stages);
      return;
    }
    void this.openStage(run, index).then(() => {
      this.settle(run);
    });
  }

  private skipStage(run: WorkflowRun, stage: number): void {
    for (const agent of agentsIn(run, stage)) {
      agent.state = 'skipped';
      agent.note = 'The board has no findings.';
    }
  }

  private finish(run: WorkflowRun): void {
    for (const agent of run.agents) {
      if (agent.state === 'pending') agent.state = 'skipped';
    }
    run.report = buildReport(run);
    run.state = 'finished';
    run.endedAt = this.deps.now();
    this.closeIdlePanes(run);
    this.commit(run);
    this.deps.notify({
      kind: 'report-ready',
      text: `${run.workflowName}: report ready.`,
      runId: run.id,
      projectPath: run.projectPath
    });
    this.deps.onEnded(run);
  }

  /** A finished run closes its panes, but a pane that a person typed in stays. */
  private closeIdlePanes(run: WorkflowRun): void {
    for (const agent of run.agents) {
      if (agent.personTyped && agent.paneId !== null) {
        const paneId = agent.paneId;
        this.panes.delete(paneId);
        agent.paneId = null;
        this.keepPane(run, agent, paneId);
      } else {
        this.stopAgent(agent);
      }
    }
    this.dropIdleWorktree(run);
    this.emitTab(run);
  }

  private commit(run: WorkflowRun): void {
    this.deps.store.save(run);
    this.deps.onRun(run);
  }

  private emitTab(run: WorkflowRun): void {
    const paneIds = run.agents.flatMap((agent) => (agent.paneId ? [agent.paneId] : []));
    paneIds.push(...run.keptPanes);
    this.deps.onTab({
      runId: run.id,
      label: run.workflowName,
      cwd: run.cwd,
      projectPath: run.projectPath,
      paneIds,
      focus: this.focus.get(run.id) ?? false
    });
  }
}
