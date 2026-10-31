import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  type BoardItem,
  type RunAgent,
  type RunOrigin,
  type RunReport,
  type RunTab,
  type WorkflowDef,
  type WorkflowNotice,
  type WorkflowProgram,
  type WorkflowRun
} from '../../shared/workflows';
import { createLogger } from '../logger';
import { agentCommandLine, type AgentMode } from './agent-command';
import { Board, boardText, type NewItem } from './board';
import { agentBrief, reminderText, RETRY_MESSAGE, START_MESSAGE } from './prompts';
import type { RunStore } from './run-store';
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
  makeWorktree: (run: WorkflowRun) => Promise<{ path: string; sha: string }>;
  removeWorktree: (run: WorkflowRun) => Promise<void>;
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
  | { kind: Exclude<PaneKind, 'outside'>; runId: string; agentId: string | null }
  | { kind: 'old-attempt' };

type Located = { run: WorkflowRun; agent: RunAgent };

const OVER_STATES = new Set<RunAgent['state']>(['done', 'skipped']);
const LIVE_STATES = new Set<RunAgent['state']>(['starting', 'working', 'waiting']);

/** A person must act on this run. A run sets its state from this. */
export function needsPerson(run: WorkflowRun): boolean {
  if (run.problem !== null) return true;
  return run.agents.some((agent) => agent.state === 'failed' || agent.needsPerson || agent.silent);
}

/** A notice about a live run goes away when that run no longer fits it. */
export function noticeIsCurrent(notice: WorkflowNotice, run: WorkflowRun | undefined): boolean {
  if (notice.kind !== 'needs-you' && notice.kind !== 'agent-start') return true;
  if (run === undefined || !isActive(run)) return false;
  return notice.kind === 'agent-start' || needsPerson(run);
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
    autoRetried: false,
    sessionId: null,
    transcriptPath: null,
    pendingPermission: null
  };
}

/** The report of a run as it stands. It always gives something to read. */
export function buildReport(run: WorkflowRun, why?: string): RunReport {
  const last = run.agents.find((agent) => agent.isLast);
  if (last?.summary) {
    return { text: last.summary, incomplete: false, missing: [], savedTo: null };
  }
  const missing = run.agents
    .filter((agent) => !agent.summary && agent.state !== 'skipped')
    .map((agent) => agent.role);
  const summaries = run.agents
    .filter((agent) => agent.summary)
    .map((agent) => `## ${agent.role}\n\n${agent.summary}`);
  if (!last && missing.length === 0 && summaries.length > 0) {
    return { text: summaries.join('\n\n'), incomplete: false, missing, savedTo: null };
  }
  return {
    text: incompleteText(run, missing, summaries, why),
    incomplete: true,
    missing,
    savedTo: null
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
  private readonly panes = new Map<string, { runId: string; agentId: string | null }>();
  /** Panes of older attempts. Their calls are refused. */
  private readonly oldPanes = new Set<string>();
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
    this.runs.set(run.id, run);
    this.boards.set(run.id, new Board(run.board));
  }

  private releaseAgent(agent: RunAgent): void {
    agent.paneId = null;
    agent.pendingPermission = null;
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
    if (pane.agentId === null) return { kind: 'post', runId: pane.runId, agentId: null };
    const located = this.locate(paneId);
    return {
      kind: located?.agent.isLast ? 'last' : 'run',
      runId: pane.runId,
      agentId: pane.agentId
    };
  }

  private locate(paneId: string): Located | null {
    const pane = this.panes.get(paneId);
    if (!pane?.agentId) return null;
    const run = this.runs.get(pane.runId);
    const agent = run?.agents.find((a) => a.id === pane.agentId);
    return run && agent ? { run, agent } : null;
  }

  /** The agents that use room now, and those of a run that is opening them. */
  private activeAgents(): number {
    const count = (run: WorkflowRun): number => {
      if (run.state === 'preparing') return run.agents.filter((a) => !a.isLast).length;
      return run.agents.filter((agent) => LIVE_STATES.has(agent.state)).length;
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
    const agents = def.agents.map((agent) => newAgent(agent.role, agent.program, false));
    if (def.judge) agents.push(newAgent(def.judge.role, def.judge.program, true));
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
      agents,
      board: [],
      report: null,
      activeMs: 0,
      limitMs: DEFAULT_LIMIT_MS,
      limitReachedAt: null,
      sleptMs: 0,
      keptPanes: [],
      postPaneId: null,
      teamPr: plan.teamPr
    };
  }

  /** Start queued runs, oldest first, while the agent limit has room. */
  private drainQueue(): void {
    for (const run of this.list()) {
      if (run.state !== 'queued') continue;
      const needed = run.agents.filter((agent) => !agent.isLast).length;
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
    for (const agent of run.agents) {
      if (!agent.isLast && isActive(run)) await this.startAgent(run, agent, false);
    }
    this.settle(run);
  }

  /** Make the worktree a PR run asks for. Answers false when it failed. */
  private async prepareWorktree(run: WorkflowRun): Promise<boolean> {
    if (!run.pr || run.worktreePath || this.defOf(run).workspace !== 'pr-worktree') return true;
    try {
      const worktree = await this.deps.makeWorktree(run);
      run.worktreePath = worktree.path;
      run.cwd = worktree.path;
      run.pr = { ...run.pr, headSha: worktree.sha };
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

  /** Try the worktree again, after a failed start. */
  retryPrepare(runId: string): void {
    const run = this.runs.get(runId);
    if (run?.state !== 'needs-you' || !run.problem || run.worktreePath) return;
    void this.launch(run);
  }

  private modeOf(run: WorkflowRun): AgentMode {
    if (run.locked) return 'locked';
    return run.teamPr ? 'team-pr' : 'normal';
  }

  private briefPath(run: WorkflowRun, agent: RunAgent): string {
    const def = this.defOf(run);
    const source = agent.isLast
      ? def.judge
      : def.agents.find((candidate) => candidate.role === agent.role);
    const brief = agentBrief(run, def, {
      role: agent.role,
      program: agent.program,
      prompt: source?.prompt ?? '',
      isLast: agent.isLast
    });
    return this.deps.store.writePrompt(run.id, `${agent.id}.md`, brief);
  }

  /** The workflow as approved. It comes from the run's own copy, never from the repo. */
  private defOf(run: WorkflowRun): WorkflowDef {
    const def = this.defs.get(run.id);
    if (!def) throw new Error(`Run ${run.id} has no stored workflow.`);
    return def;
  }

  private async startAgent(run: WorkflowRun, agent: RunAgent, resume: boolean): Promise<void> {
    this.retirePane(agent);
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

    const line = agentCommandLine({
      program: agent.program,
      mode: this.modeOf(run),
      briefPath: this.briefPath(run, agent),
      message: resume ? RETRY_MESSAGE : START_MESSAGE,
      resume: resume ? this.resumeHandle(agent) : null,
      devExtension: agent.program === 'pi' ? this.deps.devExtension : null
    });
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

  private resumeHandle(agent: RunAgent): string | null {
    return agent.program === 'pi' ? agent.transcriptPath : agent.sessionId;
  }

  /** Stop counting an agent's old pane, and refuse anything it still sends. */
  private retirePane(agent: RunAgent): void {
    if (agent.paneId === null) return;
    const paneId = agent.paneId;
    this.panes.delete(paneId);
    this.oldPanes.add(paneId);
    agent.paneId = null;
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
    this.settle(run);
  }

  /** A turn ended. Answers the text of a reminder, when Fleet must send one. */
  onTurnEnd(paneId: string): string | null {
    const located = this.locate(paneId);
    if (!located) return null;
    const { agent, run } = located;
    if (agent.state !== 'working') return null;

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

  private notifyNeedsYou(run: WorkflowRun, agent: RunAgent): void {
    this.deps.notify({
      kind: 'needs-you',
      text: `${run.workflowName}: ${agent.role} needs you.`,
      runId: run.id,
      projectPath: run.projectPath
    });
  }

  onApiFailure(paneId: string, message: string): void {
    const located = this.locate(paneId);
    // A follow-up turn after the finish call changes nothing about the run.
    if (!located || !isActive(located.run) || !LIVE_STATES.has(located.agent.state)) return;
    this.failAgent(located.run, located.agent, message, true);
    this.settle(located.run);
  }

  onPermission(paneId: string, toolUseId: string | null, tool: string): void {
    const located = this.locate(paneId);
    if (located?.agent.state !== 'working') return;
    const { agent, run } = located;
    agent.state = 'waiting';
    agent.needsPerson = true;
    agent.note = `It asks to use ${tool}.`;
    agent.pendingPermission = toolUseId ? { toolUseId, tool } : null;
    this.notifyNeedsYou(run, agent);
    this.settle(run);
  }

  /** A person typed in a pane. Enter sends a turn, so that turn is theirs. */
  onPersonInput(paneId: string, data: string): void {
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
    pane: { runId: string; agentId: string | null },
    killed: boolean
  ): void {
    const run = this.runs.get(pane.runId);
    this.panes.delete(paneId);
    if (!run) return;
    if (run.postPaneId === paneId) {
      run.postPaneId = null;
      this.emitTab(run);
      this.commit(run);
      return;
    }
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
    if (run.keptPanes.length === 0) this.dropWorktree(run);
    this.emitTab(run);
    this.commit(run);
  }

  // --- Tools ---

  private located(runId: string, agentId: string | null): Located | null {
    const run = this.runs.get(runId);
    const agent = run?.agents.find((candidate) => candidate.id === agentId);
    return run && agent ? { run, agent } : null;
  }

  private persistItem(run: WorkflowRun, item: BoardItem): void {
    this.deps.store.appendBoard(run.id, item);
  }

  private boardOf(runId: string, agentId: string | null): Located & { board: Board } {
    const located = this.located(runId, agentId);
    const board = this.boards.get(runId);
    if (!located || !board) throw new Error('This pane is not in a run.');
    return { ...located, board };
  }

  private publishBoard(run: WorkflowRun, board: Board): void {
    run.board = board.all();
    this.deps.onRun(run);
  }

  addFinding(runId: string, agentId: string | null, item: NewItem): ReturnType<Board['add']> {
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

  mergeFindings(runId: string, agentId: string | null, ids: string[], item: NewItem): BoardItem {
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
  finishAgent(runId: string, agentId: string | null, summary: string): string | null {
    const located = this.located(runId, agentId);
    if (!located) return 'This pane is not in a run.';
    const { run, agent } = located;
    if (summary.trim() === '') return 'The summary is empty.';
    if (agent.state === 'done')
      return 'You already finished. Follow-up turns do not change the report.';
    if (!isActive(run)) return 'This run has ended.';
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
    await this.startAgent(located.run, located.agent, this.resumeHandle(located.agent) !== null);
    this.settle(located.run);
  }

  skip(runId: string, agentId: string): void {
    const located = this.actionable(runId, agentId);
    if (!located) return;
    const { run, agent } = located;
    this.retirePane(agent);
    agent.state = 'skipped';
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
    if (!OVER_STATES.has(agent.state) && agent.state !== 'pending') agent.state = 'failed';
  }

  /** Go on with a cut-off run: each unfinished agent starts again on its old transcript. */
  async goOn(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run?.state !== 'cut-off') return;
    run.state = 'running';
    run.endedAt = null;
    run.problem = null;
    this.restoreDef(run);
    // The cut can come before the worktree exists, or between two agents.
    if (!(await this.prepareWorktree(run))) return;
    for (const agent of run.agents) {
      if (agent.state === 'failed') await this.startAgent(run, agent, true);
      if (agent.state === 'pending' && !agent.isLast) await this.startAgent(run, agent, false);
    }
    this.settle(run);
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
    run.keptPanes = [];
    this.closePostPane(run);
    if (removeWorktree) this.dropWorktree(run);
    run.state = 'closed';
    this.emitTab(run);
    this.commit(run);
  }

  private closePostPane(run: WorkflowRun): void {
    if (run.postPaneId === null) return;
    this.panes.delete(run.postPaneId);
    this.deps.killPane(run.postPaneId);
    run.postPaneId = null;
  }

  private dropWorktree(run: WorkflowRun): void {
    if (!run.worktreePath) return;
    void this.deps.removeWorktree(run).catch((err: unknown) => {
      log.warn('a run worktree was not removed', { runId: run.id, error: String(err) });
    });
    run.worktreePath = null;
    run.cwd = run.projectPath;
  }

  /** Open a pane that can only post stored findings. */
  async openPostPane(runId: string, line: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.closePostPane(run);
    const paneId = randomUUID();
    run.postPaneId = paneId;
    this.panes.set(paneId, { runId, agentId: null });
    await this.deps.openPane({ paneId, cwd: run.cwd, line });
    this.emitTab(run);
    this.commit(run);
  }

  /** Mark an item, safe on disk before the call returns. */
  markPost(runId: string, id: string, post: BoardItem['post']): void {
    const run = this.runs.get(runId);
    const board = this.boards.get(runId);
    const item = board?.get(id);
    if (!run || !item) return;
    item.post = post;
    this.persistItem(run, item);
    run.board = board?.all() ?? [];
    this.deps.onRun(run);
  }

  setSavedTo(runId: string, path: string): void {
    const run = this.runs.get(runId);
    if (!run?.report) return;
    run.report = { ...run.report, savedTo: path };
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
      if (delta >= SLEEP_GAP_MS) this.skipSleep(run, delta);
      else if (run.state !== 'queued') run.activeMs += delta;
      for (const agent of run.agents) this.watchAgent(run, agent, now);
      this.watchLimit(run, now);
      if (isActive(run)) this.settle(run);
    }
    this.drainQueue();
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
    this.startLastAgent(run);
    if (run.agents.every((agent) => OVER_STATES.has(agent.state))) {
      this.finish(run);
      return;
    }
    if (this.noWayOn(run)) {
      this.finish(run);
      return;
    }
    run.state = needsPerson(run) ? 'needs-you' : 'running';
    this.commit(run);
  }

  private startLastAgent(run: WorkflowRun): void {
    const last = run.agents.find((agent) => agent.isLast);
    if (last?.state !== 'pending') return;
    const others = run.agents.filter((agent) => !agent.isLast);
    if (!others.every((agent) => OVER_STATES.has(agent.state))) return;
    if (others.some((agent) => agent.state === 'done')) void this.startAgent(run, last, false);
    else last.state = 'skipped';
  }

  /** Every agent failed or was skipped: nothing can go on, so the run ends as it stands. */
  private noWayOn(run: WorkflowRun): boolean {
    const others = run.agents.filter((agent) => !agent.isLast);
    return others.every(
      (agent) => agent.state === 'skipped' || (agent.state === 'failed' && agent.autoRetried)
    );
  }

  private finish(run: WorkflowRun): void {
    for (const agent of run.agents) {
      if (agent.state === 'pending') agent.state = 'skipped';
    }
    run.report = buildReport(run);
    run.state = 'finished';
    run.endedAt = this.deps.now();
    if (run.origin === 'automatic') this.closeAutomatic(run);
    this.commit(run);
    this.deps.notify({
      kind: 'report-ready',
      text: `${run.workflowName}: report ready.`,
      runId: run.id,
      projectPath: run.projectPath
    });
    this.deps.onEnded(run);
  }

  /** An automatic run closes itself, but a pane that a person typed in stays. */
  private closeAutomatic(run: WorkflowRun): void {
    for (const agent of run.agents) {
      if (agent.personTyped && agent.paneId !== null) {
        run.keptPanes.push(agent.paneId);
        // Its agent lives on, and it must not read as a pane outside any run.
        this.panes.delete(agent.paneId);
        this.oldPanes.add(agent.paneId);
        agent.paneId = null;
      } else {
        this.stopAgent(agent);
      }
    }
    if (run.keptPanes.length === 0) this.dropWorktree(run);
    this.emitTab(run);
  }

  private commit(run: WorkflowRun): void {
    this.deps.store.save(run);
    this.deps.onRun(run);
  }

  private emitTab(run: WorkflowRun): void {
    const paneIds = run.agents.flatMap((agent) => (agent.paneId ? [agent.paneId] : []));
    if (run.postPaneId) paneIds.push(run.postPaneId);
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
