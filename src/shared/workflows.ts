// The shapes shared by the main process and the renderer for Fleet Workflows.

export type WorkflowProgram = 'pi' | 'claude';

export type WorkflowInput = {
  name: string;
  label: string;
  type: 'text' | 'pr';
  required: boolean;
};

export type WorkflowAgentDef = {
  role: string;
  program: WorkflowProgram;
  prompt: string;
};

export type WorkflowFinish = {
  action: 'save-report' | 'post-pr';
  path?: string;
};

export type WorkflowDef = {
  name: string;
  shared: string;
  board: boolean;
  workspace: 'current' | 'pr-worktree';
  inputs: WorkflowInput[];
  agents: WorkflowAgentDef[];
  judge?: WorkflowAgentDef;
  finish?: WorkflowFinish;
};

export type WorkflowScope = 'project' | 'personal';

export type WorkflowApproval = 'approved' | 'needs-approval' | 'changed';

/** One TOML file, whether or not it parsed. */
export type WorkflowEntry = {
  /** The file name without `.toml`. A project file wins over a personal one with this name. */
  id: string;
  path: string;
  scope: WorkflowScope;
  hash: string;
  def: WorkflowDef | null;
  /** What is wrong with the file, with its line when it has one. */
  error: string | null;
  approval: WorkflowApproval;
  /** Set when this project file replaces a personal file of the same name. */
  replacesPersonal: boolean;
  /** The text the approval covers, to show only what changed. */
  approvedText: string | null;
};

export type AgentState =
  | 'pending'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped';

export type RunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'needs-you'
  | 'finished'
  | 'stopped'
  | 'cut-off'
  | 'closed';

export const ACTIVE_RUN_STATES: readonly RunState[] = [
  'queued',
  'preparing',
  'running',
  'needs-you'
];

export type RunAgent = {
  id: string;
  role: string;
  program: WorkflowProgram;
  isLast: boolean;
  state: AgentState;
  paneId: string | null;
  attempt: number;
  summary: string | null;
  /** Why this agent stopped or waits, for the Live view. */
  note: string | null;
  /** The next turn end with no finish call goes to a person, not to a reminder. */
  reminded: boolean;
  /** A person must act: a failed turn, or a wait that a reminder did not end. */
  needsPerson: boolean;
  /** No output for 5 minutes. A flag only: it never fails the agent. */
  silent: boolean;
  /** A person typed in this pane, so it stays open after an automatic run. */
  personTyped: boolean;
  autoRetried: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  /** A permission request Fleet can answer for this agent. */
  pendingPermission: { toolUseId: string; tool: string } | null;
};

export type BoardItem = {
  id: string;
  agent: string;
  kind: string;
  text: string;
  file?: string;
  line?: number;
  source?: string;
  /** The ids this item replaced, for a merged item. */
  mergedFrom?: string[];
  /** Replaced by a merged item, so it no longer counts. */
  mergedInto?: string;
  post?: 'posting' | 'posted' | 'failed';
};

export type RunReport = {
  text: string;
  incomplete: boolean;
  /** The agents with no summary, for an Incomplete report. */
  missing: string[];
  savedTo: string | null;
};

export type PrRef = {
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** What the run reviewed moved on after it started. */
  movedOn: boolean;
};

export type RunOrigin = 'manual' | 'agent' | 'automatic';

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowPath: string;
  projectPath: string;
  hash: string;
  inputs: Record<string, string>;
  /** The PR number, or else the input values. One run per workflow and target. */
  target: string;
  slug: string;
  origin: RunOrigin;
  ruleId: string | null;
  state: RunState;
  createdAt: number;
  endedAt: number | null;
  cwd: string;
  worktreePath: string | null;
  pr: PrRef | null;
  /** A stranger's PR. Agents start with read-only tools. */
  locked: boolean;
  /** What stopped a queued or a failed start, for a person to read. */
  problem: string | null;
  usesBoard: boolean;
  finish: WorkflowFinish | null;
  agents: RunAgent[];
  board: BoardItem[];
  report: RunReport | null;
  /** Time used so far, without sleep. */
  activeMs: number;
  limitMs: number;
  /** When a manual run reached its limit. It stops 10 minutes after this. */
  limitReachedAt: number | null;
  sleptMs: number;
  /** Panes a person kept open after an automatic run. */
  keptPanes: string[];
  /** The agent that posts findings, while one is open. */
  postPaneId: string | null;
  /** A team's PR in its own worktree, so agents approve their own tools. */
  teamPr: boolean;
};

/** Where to find a run's panes on screen. */
export type RunTab = {
  runId: string;
  label: string;
  cwd: string;
  projectPath: string;
  paneIds: string[];
  /** A manual start opens its tab in front. */
  focus: boolean;
};

export type RuleTrigger =
  | { kind: 'time'; at: string; days: number[] }
  | {
      kind: 'interval';
      minutes: number;
      days: number[];
      window: { from: string; to: string } | null;
    }
  | { kind: 'new-pr'; includeStrangers: boolean; includeDrafts: boolean };

export type RuleMissed = 'run-once' | 'skip';

export type WorkflowRule = {
  id: string;
  name: string;
  projectPath: string;
  workflowId: string;
  inputs: Record<string, string>;
  trigger: RuleTrigger;
  missed: RuleMissed;
  enabled: boolean;
  /** Why the rule paused. A person or a fixed problem clears it. */
  pausedReason: string | null;
  dailyLimit: number;
  /** When the rule last started a run, or chose to skip one. */
  lastStart: number | null;
  createdAt: number;
};

export type AwayEntry = {
  id: string;
  at: number;
  ruleId: string | null;
  ruleName: string;
  text: string;
  /** Offers Run now for this rule. */
  canRun: boolean;
};

export type WorkflowLimits = {
  maxAgents: number;
  runOnBattery: boolean;
};

export type WorkflowNotice = {
  id: string;
  kind: 'report-ready' | 'needs-you' | 'agent-start' | 'agent-create' | 'queued' | 'limit' | 'info';
  text: string;
  runId: string | null;
  projectPath: string | null;
  /** An agent asks to start this file. Allow or Deny answers it. */
  ask?: { path: string; hash: string };
};

export type WorkflowsState = {
  runs: WorkflowRun[];
  rules: WorkflowRule[];
  away: AwayEntry[];
  notices: WorkflowNotice[];
  limits: WorkflowLimits;
};

export type WorkflowProject = {
  path: string;
  name: string;
  isRepo: boolean;
};

/** One check before a run starts. A failed one stops the start and says how to go on. */
export type WorkflowCheck = {
  label: string;
  ok: boolean;
  detail?: string;
  /** The way on, as words for a button or a hint. */
  fix?: string;
};

export type WorkflowPreview = {
  checks: WorkflowCheck[];
  /** The PR the run would use, once its input is known. */
  pr: { number: number; title: string; url: string; state: string; locked: boolean } | null;
  /** Claude Code agents that cannot run here, with the reason. */
  programNotes: string[];
  /** An active run for this workflow and target. */
  duplicateRunId: string | null;
};

export type StartRunRequest = {
  projectPath: string;
  workflowId: string;
  inputs: Record<string, string>;
  /** Start even with an active run for this target. */
  force?: boolean;
  /** Review a closed PR anyway. */
  allowClosedPr?: boolean;
  /** Treat a stranger's PR as a team PR, for this run. */
  trustPr?: boolean;
  /** Program to use per agent role, when a program is not usable here. */
  programOverride?: WorkflowProgram;
};

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; code: string; message: string; runId?: string };

export type SaveReportResult =
  | { ok: true; path: string }
  | { ok: false; code: 'exists' | 'refused' | 'failed'; message: string };

export type SaveWorkflowRequest = {
  projectPath: string;
  scope: WorkflowScope;
  fileName: string;
  text: string;
  /** The file's hash when it was opened. A different hash on disk stops the save. */
  baseHash: string | null;
};

export type SaveWorkflowResult =
  | { ok: true; id: string; path: string }
  | { ok: false; code: 'invalid' | 'changed' | 'exists'; message: string; diskText?: string };

export type WorkflowStarter = {
  id: string;
  label: string;
  description: string;
  text: string;
};

export type RuleInput = Omit<WorkflowRule, 'id' | 'createdAt' | 'lastStart'> & { id?: string };

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** About how many runs a rule starts on a day it runs, for the form's preview. */
export function runsPerDay(trigger: RuleTrigger): number {
  if (trigger.kind === 'time') return 1;
  if (trigger.kind === 'new-pr') return 0;
  if (trigger.window === null) return Math.floor(1440 / trigger.minutes);
  const from = minutesOf(trigger.window.from);
  const to = minutesOf(trigger.window.to);
  const span = to > from ? to - from : 1440 - from + to;
  return Math.floor(span / trigger.minutes);
}

/** Everything the page can ask of main, over one channel. */
export type WorkflowsApi = {
  state: () => WorkflowsState;
  tabs: () => RunTab[];
  projects: (paths: string[]) => Promise<WorkflowProject[]>;
  pickProject: () => Promise<string | null>;
  list: (projectPath: string) => WorkflowEntry[];
  readText: (path: string) => string;
  starters: () => { blank: string; starters: WorkflowStarter[] };
  save: (req: SaveWorkflowRequest) => SaveWorkflowResult;
  remove: (projectPath: string, id: string) => void;
  approve: (projectPath: string, id: string, hash: string) => boolean;
  importToml: (projectPath: string, scope: WorkflowScope) => Promise<string | null>;
  preview: (req: StartRunRequest) => Promise<WorkflowPreview>;
  start: (req: StartRunRequest) => Promise<StartRunResult>;
  stop: (runId: string) => void;
  close: (runId: string, removeWorktree: boolean) => void;
  retry: (runId: string, agentId: string) => Promise<void>;
  skip: (runId: string, agentId: string) => void;
  keepWaiting: (runId: string, agentId: string) => void;
  addTime: (runId: string) => void;
  goOn: (runId: string) => Promise<void>;
  retryPrepare: (runId: string) => void;
  answerPermission: (toolUseId: string, decision: 'allow' | 'deny') => boolean;
  reportPath: (runId: string) => string | null;
  saveReport: (runId: string, path: string, replace: boolean) => SaveReportResult;
  pickReportPath: (runId: string) => Promise<SaveReportResult | null>;
  post: (runId: string) => Promise<number>;
  remainingPosts: (runId: string) => number;
  dismissNotice: (id: string) => void;
  answerAsk: (id: string, allow: boolean) => void;
  saveRule: (rule: RuleInput) => WorkflowRule;
  deleteRule: (id: string) => void;
  setRuleEnabled: (id: string, enabled: boolean) => void;
  runRule: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  setLimits: (limits: WorkflowLimits) => void;
  clearAway: () => void;
};
