import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ClaudeSessionChange } from '../../shared/claude-sessions';
import type {
  RunTab,
  SaveReportResult,
  StartRunRequest,
  StartRunResult,
  WorkflowDef,
  WorkflowEntries,
  WorkflowEntry,
  WorkflowNotice,
  WorkflowProgram,
  WorkflowProject,
  WorkflowRule,
  WorkflowRun,
  WorkflowsState
} from '../../shared/workflows';
import { createLogger } from '../logger';
import { ApprovalStore, loadSigningKey, SignedFile, type KeyVault } from './approval';
import { WorkflowAgentTools } from './agent-tools';
import type { BridgeHandler, PiEvent, WorkflowsBridge } from './bridge-routes';
import { WorkflowCatalog } from './catalog';
import { parseWorkflow, PROJECT_WORKFLOWS_DIR, readWorkflowFile } from './config';
import { FolderWatcher, type WatchTarget } from './folder-watcher';
import { WorkflowPosting } from './posting';
import { WorkflowPower, type PowerApi } from './power';
import {
  fetchPr,
  listOpenPrs,
  makePrWorktree,
  removeWorktree,
  repoRoot,
  runProgram,
  type Exec
} from './pr';
import { resolveReportPath, writeReport } from './report';
import { RunStore } from './run-store';
import { placeholderValues } from './prompts';
import { isActive, noticeIsCurrent, WorkflowRunManager, type PaneIdentity } from './run-manager';
import {
  EMPTY_RULES,
  RULES_SCHEMA,
  startOutcome,
  WorkflowScheduler,
  type StartOutcome
} from './scheduler';
import { BLANK_WORKFLOW, STARTERS } from './starters';
import { WorkflowStarts } from './starts';
import type { ToolName } from './tools';

const log = createLogger('workflows');

const CLOCK_MS = 5_000;
/** Holds a person's own workflows, inside the Fleet home folder. */
const PERSONAL_DIR_NAME = 'workflows';
const WORKING = new Set(['starting', 'working']);

export type WorkflowsDeps = {
  home: string;
  platform: NodeJS.Platform;
  now: () => number;
  vault: KeyVault;
  power: PowerApi;
  bridge: WorkflowsBridge;
  /** Opens a pane with no screen yet, which a line is typed into. */
  openPane: (pane: { paneId: string; cwd: string; line: string }) => Promise<void>;
  killPane: (paneId: string) => void;
  paneCwd: (paneId: string) => string | undefined;
  openFolders: () => string[];
  tokenOf: (paneId: string) => string | undefined;
  lastOutputAt: (paneId: string) => number;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  /** Claims permission requests, until the returned function is called. */
  addPermissionAnswerer: () => () => void;
  answerPermission: (toolUseId: string, decision: 'allow' | 'deny') => boolean;
  subscribeSessions: (listener: (change: ClaudeSessionChange) => void) => void;
  bridgeProblem: () => string | null;
  hasProgram: (program: WorkflowProgram) => Promise<boolean>;
  devExtension: string | null;
  /** Pushes to the page, when one is open. */
  onState: (state: WorkflowsState) => void;
  onEntries: (entries: WorkflowEntries) => void;
  onTab: (tab: RunTab) => void;
  exec?: Exec;
};

/** The whole of Workflows in main: it builds the parts and answers the page and the bridge. */
export class WorkflowsService implements BridgeHandler {
  readonly catalog: WorkflowCatalog;
  readonly runs: WorkflowRunManager;
  readonly scheduler: WorkflowScheduler;
  private readonly approvals: ApprovalStore;
  private readonly starts: WorkflowStarts;
  private readonly posting: WorkflowPosting;
  private readonly agentTools: WorkflowAgentTools;
  private readonly power: WorkflowPower;
  private readonly exec: Exec;
  private notices: WorkflowNotice[] = [];
  private clock: ReturnType<typeof setInterval> | null = null;
  private releaseAnswerer: (() => void) | null = null;
  private readonly tabs = new Map<string, RunTab>();
  private readonly folders = new FolderWatcher(() => this.pushEntries());
  /** The project the page shows. Its workflow files are the ones to watch. */
  private shownProject: string | null = null;

  constructor(private readonly deps: WorkflowsDeps) {
    mkdirSync(deps.home, { recursive: true });
    this.exec = deps.exec ?? runProgram;
    const key = loadSigningKey(deps.home, deps.vault);
    const personalDir = join(deps.home, PERSONAL_DIR_NAME);
    const store = new RunStore(join(deps.home, 'workflow-runs'));

    this.approvals = new ApprovalStore(join(deps.home, 'workflow-approvals.json'), key);
    this.catalog = new WorkflowCatalog(this.approvals, personalDir, () => this.pushEntries());
    this.scheduler = new WorkflowScheduler({
      file: new SignedFile(join(deps.home, 'workflow-rules.json'), key, RULES_SCHEMA, EMPTY_RULES),
      now: deps.now,
      start: async (rule, pr) => this.startFromRule(rule, pr),
      busy: (rule) => this.ruleBusy(rule),
      onBattery: () => this.power.onBattery(),
      listPrs: async (rule) => listOpenPrs(this.exec, rule.projectPath),
      onChange: () => this.pushState()
    });
    this.runs = new WorkflowRunManager({
      store,
      now: deps.now,
      openPane: deps.openPane,
      killPane: deps.killPane,
      lastOutputAt: deps.lastOutputAt,
      sendPrompt: deps.sendPrompt,
      makeWorktree: async (run, pinnedSha) =>
        makePrWorktree(this.exec, {
          projectPath: run.projectPath,
          runId: run.id,
          prNumber: run.pr?.number ?? 0,
          base: join(deps.home, 'worktrees'),
          pinnedSha
        }),
      removeWorktree: async (run) =>
        removeWorktree(this.exec, run.projectPath, run.worktreePath ?? ''),
      onRun: () => this.onRunChange(),
      onTab: (tab) => this.onTab(tab),
      notify: (notice) => this.notify(notice),
      onEnded: (run) => this.onRunEnded(run),
      maxAgents: () => this.scheduler.limits().maxAgents,
      devExtension: deps.devExtension,
      parse: parseWorkflow
    });
    this.starts = new WorkflowStarts({
      catalog: this.catalog,
      approvals: this.approvals,
      runs: this.runs,
      exec: this.exec,
      platform: deps.platform,
      bridgeProblem: deps.bridgeProblem,
      hasProgram: deps.hasProgram
    });
    this.posting = new WorkflowPosting({ runs: this.runs, exec: this.exec });
    this.agentTools = new WorkflowAgentTools({
      catalog: this.catalog,
      approvals: this.approvals,
      runs: this.runs,
      starts: this.starts,
      exec: this.exec,
      paneCwd: deps.paneCwd,
      openFolders: deps.openFolders,
      notify: (notice) => this.notify(notice)
    });
    this.power = new WorkflowPower(deps.power, {
      onSuspend: () => this.runs.suspend(),
      onResume: () => this.runs.resume(),
      onSourceChange: () => this.updatePower()
    });
  }

  start(): void {
    this.deps.bridge.connect(this);
    this.deps.subscribeSessions((change) => this.onSessionChange(change));
    this.power.start();
    this.scheduler.start();
    this.clock = setInterval(() => this.runs.tick(), CLOCK_MS);
    this.clock.unref();
  }

  /** Fleet is quitting. Every active run is cut off before its PTYs die. */
  stop(): void {
    if (this.clock) clearInterval(this.clock);
    this.scheduler.stop();
    this.folders.dispose();
    this.runs.markCutOff();
    this.power.update(false);
    this.releaseAnswerer?.();
    this.releaseAnswerer = null;
  }

  hasActive(): boolean {
    return this.runs.hasActive();
  }

  state(): WorkflowsState {
    return {
      runs: this.runs.list(),
      rules: this.scheduler.rules(),
      away: this.scheduler.awayList(),
      notices: this.notices,
      limits: this.scheduler.limits()
    };
  }

  private dropOldNotices(): void {
    this.notices = this.notices.filter((notice) => {
      return noticeIsCurrent(notice, notice.runId ? this.runs.get(notice.runId) : undefined);
    });
  }

  private pushState(): void {
    this.dropOldNotices();
    this.deps.onState(this.state());
  }

  /** The page's list of workflow files, and the files to watch from now on. */
  list(projectPath: string): WorkflowEntry[] {
    if (projectPath !== this.shownProject) {
      this.shownProject = projectPath;
      this.folders.watch(this.workflowFolders(projectPath));
    }
    return this.catalog.list(projectPath);
  }

  /** The workflow folders, and the parents that show when one is made or deleted. */
  private workflowFolders(projectPath: string): WatchTarget[] {
    const project = join(projectPath, PROJECT_WORKFLOWS_DIR);
    const fleetDir = dirname(project);
    return [
      { dir: projectPath, only: basename(fleetDir) },
      { dir: fleetDir, only: basename(project) },
      { dir: project },
      { dir: this.deps.home, only: PERSONAL_DIR_NAME },
      { dir: join(this.deps.home, PERSONAL_DIR_NAME) }
    ];
  }

  private pushEntries(): void {
    const projectPath = this.shownProject;
    if (projectPath) this.deps.onEntries({ projectPath, entries: this.catalog.list(projectPath) });
  }

  private onRunChange(): void {
    this.updatePower();
    this.syncAnswerer();
    this.pushState();
  }

  private updatePower(): void {
    const agents = this.runs
      .list()
      .filter(isActive)
      .flatMap((run) => run.agents);
    this.power.update(agents.some((agent) => WORKING.has(agent.state)));
  }

  /** Hold Claude Code's permission requests only while a run can show them. */
  private syncAnswerer(): void {
    const claudeRun = this.runs
      .list()
      .some((run) => isActive(run) && run.agents.some((agent) => agent.program === 'claude'));
    if (claudeRun && !this.releaseAnswerer) {
      this.releaseAnswerer = this.deps.addPermissionAnswerer();
    } else if (!claudeRun && this.releaseAnswerer) {
      this.releaseAnswerer();
      this.releaseAnswerer = null;
    }
  }

  private onTab(tab: RunTab): void {
    this.tabs.set(tab.runId, tab);
    this.deps.onTab(tab);
  }

  /** Every run tab, for a page that opened after the runs started. */
  listTabs(): RunTab[] {
    return [...this.tabs.values()].filter((tab) => tab.paneIds.length > 0);
  }

  // --- Notices ---

  notify(notice: Omit<WorkflowNotice, 'id'>): void {
    this.notices = [...this.notices, { ...notice, id: randomUUID() }];
    this.pushState();
  }

  dismissNotice(id: string): void {
    this.notices = this.notices.filter((notice) => notice.id !== id);
    this.pushState();
  }

  /** A person answers an agent's ask. Allow lasts until the file changes. */
  answerAsk(id: string, allow: boolean): void {
    const notice = this.notices.find((candidate) => candidate.id === id);
    this.dismissNotice(id);
    if (!allow || !notice?.ask || !notice.projectPath) return;
    this.approvals.allowAgents(notice.ask.path, notice.ask.hash);
  }

  // --- Signals ---

  /** Pi tells Fleet of its turns on the bridge, so only Claude Code comes through here. */
  private onSessionChange({ session, event }: ClaudeSessionChange): void {
    if (session?.runtime !== 'claude' || !event) return;
    const { paneId, sessionId } = session;
    switch (event.event) {
      case 'SessionStart':
        this.runs.onSessionStart(paneId, {
          id: sessionId,
          transcriptPath: session.transcriptPath ?? null
        });
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
        this.runs.onTurnStart(paneId);
        break;
      case 'Stop':
        this.remindClaude(paneId, sessionId);
        break;
      case 'StopFailure':
        this.runs.onApiFailure(paneId, event.message ?? 'The API call failed.');
        break;
      case 'PermissionRequest':
        this.onPermission(session.paneId, session.pendingPermissions.at(-1));
        break;
    }
  }

  private onPermission(
    paneId: string,
    pending: { toolUseId: string; tool: { toolName: string } } | undefined
  ): void {
    this.runs.onPermission(paneId, pending?.toolUseId ?? null, pending?.tool.toolName ?? 'a tool');
  }

  private remindClaude(paneId: string, sessionId: string): void {
    const reminder = this.runs.onTurnEnd(paneId);
    if (!reminder) return;
    void this.deps.sendPrompt(sessionId, reminder).catch((err: unknown) => {
      log.warn('a reminder was not sent', { error: String(err) });
    });
  }

  onPiEvent(paneId: string, event: PiEvent): { reminder?: string } {
    const { runs } = this;
    if (event.event === 'session_start') {
      runs.onSessionStart(paneId, { id: event.sessionId, transcriptPath: event.transcriptPath });
    } else if (event.event === 'turn_start') {
      runs.onTurnStart(paneId);
    } else if (event.event === 'api_error') {
      runs.onApiFailure(paneId, event.message ?? 'The API call failed.');
    } else {
      const reminder = runs.onTurnEnd(paneId);
      if (reminder) return { reminder };
    }
    return {};
  }

  onPaneInput(paneId: string, data: string): void {
    this.runs.onPersonInput(paneId, data);
  }

  onPaneClosed(paneId: string, killed: boolean): void {
    this.runs.onPaneClosed(paneId, killed);
  }

  // --- Bridge ---

  tokenOf(paneId: string): string | undefined {
    return this.deps.tokenOf(paneId);
  }

  identify(paneId: string): PaneIdentity {
    return this.runs.identify(paneId);
  }

  async call(
    paneId: string,
    identity: PaneIdentity,
    tool: ToolName,
    args: unknown
  ): Promise<unknown> {
    return this.agentTools.call(paneId, identity, tool, args);
  }

  // --- The page ---

  async startManual(req: StartRunRequest): Promise<StartRunResult> {
    return this.starts.start(req, { origin: 'manual', ruleId: null, focus: true });
  }

  async preview(req: StartRunRequest): ReturnType<WorkflowStarts['preview']> {
    return this.starts.preview(req);
  }

  /** Folders as projects: each one's repo root, once each. */
  async projects(paths: string[]): Promise<WorkflowProject[]> {
    const known = [...paths, ...this.runs.list().map((run) => run.projectPath)];
    const roots = await Promise.all([...new Set(known)].map(async (path) => this.projectAt(path)));
    return [...new Map(roots.map((project) => [project.path, project])).values()];
  }

  private async projectAt(path: string): Promise<WorkflowProject> {
    const root = await repoRoot(this.exec, path);
    let isRepo = true;
    try {
      await this.exec('git', ['rev-parse', '--git-dir'], root);
    } catch {
      isRepo = false;
    }
    return { path: root, name: basename(root), isRepo };
  }

  starters(): { blank: string; starters: typeof STARTERS } {
    return { blank: BLANK_WORKFLOW, starters: STARTERS };
  }

  approve(projectPath: string, id: string, hash: string): boolean {
    const approved = this.catalog.approve(projectPath, id, hash);
    if (approved) {
      this.scheduler.resumePaused(
        (rule) => rule.projectPath === projectPath && rule.workflowId === id
      );
      this.dropCreateNotice(projectPath, id);
    }
    return approved;
  }

  /** The file an agent made was approved or deleted, so nothing waits for review. */
  private dropCreateNotice(projectPath: string, id: string): void {
    this.notices = this.notices.filter(
      (notice) =>
        notice.kind !== 'agent-create' ||
        notice.projectPath !== projectPath ||
        notice.workflowId !== id
    );
    this.pushState();
  }

  /** A deleted file pauses each rule that uses it, with the reason. */
  remove(projectPath: string, id: string): void {
    this.catalog.remove(projectPath, id);
    for (const rule of this.scheduler.rules()) {
      if (rule.projectPath === projectPath && rule.workflowId === id) {
        this.scheduler.pause(rule.id, 'Its workflow file was deleted.');
      }
    }
    this.dropCreateNotice(projectPath, id);
  }

  /** A file from outside: it arrives needing approval, as any file a person did not write here. */
  importFile(projectPath: string, scope: 'project' | 'personal', source: string): string {
    return this.catalog.createPending(
      projectPath,
      scope,
      basename(source).replace(/\.toml$/, ''),
      readWorkflowFile(source).text
    );
  }

  // --- Reports ---

  /** Where the Save report button points first. */
  reportPath(runId: string): string | null {
    const run = this.runs.get(runId);
    if (!run?.finish?.path) return null;
    return run.finish.path.replace(/\{\{\s*slug\s*\}\}/g, run.slug);
  }

  saveReport(runId: string, relPath: string, replace: boolean): SaveReportResult {
    const run = this.runs.get(runId);
    if (!run?.report) return { ok: false, code: 'failed', message: 'This run has no report.' };
    const resolved = resolveReportPath(run.projectPath, relPath, placeholderValues(run));
    if ('refused' in resolved) return { ok: false, code: 'refused', message: resolved.refused };
    return this.writeRunReport(run, resolved.path, replace);
  }

  /** A folder from the native dialog: a person picked it, so it may be anywhere. */
  saveReportAt(runId: string, path: string, replace: boolean): SaveReportResult {
    const run = this.runs.get(runId);
    if (!run?.report) return { ok: false, code: 'failed', message: 'This run has no report.' };
    return this.writeRunReport(run, path, replace);
  }

  private writeRunReport(run: WorkflowRun, path: string, replace: boolean): SaveReportResult {
    const result = writeReport(path, run.report?.text ?? '', replace);
    if (result.ok && run.report) this.runs.updateReport(run.id, { savedTo: result.path });
    return result;
  }

  async post(runId: string): Promise<void> {
    return this.posting.post(runId);
  }

  answerPermission(toolUseId: string, decision: 'allow' | 'deny'): boolean {
    const answered = this.deps.answerPermission(toolUseId, decision);
    // False means that the request is gone. Either way, nothing waits for a person.
    this.runs.onPermissionAnswered(toolUseId);
    return answered;
  }

  private onRunEnded(run: WorkflowRun): void {
    this.checkMovedOn(run);
  }

  /** A PR that got a new commit makes the findings old. The run's end says so. */
  private checkMovedOn(run: WorkflowRun): void {
    if (!run.pr) return;
    const { number, headSha } = run.pr;
    void fetchPr(this.exec, run.projectPath, number)
      .then((pr) => {
        if (pr.headSha !== headSha) this.runs.noteMovedOn(run.id, pr.headSha);
      })
      .catch((err: unknown) => {
        log.debug('could not check the PR at the end of a run', { error: String(err) });
      });
  }

  // --- Rules ---

  private ruleBusy(rule: WorkflowRule): boolean {
    return this.runs.list().some((run) => run.ruleId === rule.id && isActive(run));
  }

  private inputsFor(
    rule: WorkflowRule,
    def: WorkflowDef | null,
    pr: number | null
  ): Record<string, string> {
    const input = def?.inputs.find((candidate) => candidate.type === 'pr');
    return pr !== null && input ? { ...rule.inputs, [input.name]: String(pr) } : rule.inputs;
  }

  private async startFromRule(rule: WorkflowRule, pr: number | null): Promise<StartOutcome> {
    const { projectPath, workflowId } = rule;
    const entry = this.catalog.find(projectPath, workflowId);
    if (!entry) return { ok: false, busy: false, reason: 'Its workflow file is gone.' };

    const inputs = this.inputsFor(rule, entry.def, pr);
    const started = await this.starts.start(
      { projectPath, workflowId, inputs },
      { origin: 'automatic', ruleId: rule.id, focus: false }
    );
    return startOutcome(started, pr);
  }
}
