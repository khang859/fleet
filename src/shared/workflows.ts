// The shapes shared by the main process and the renderer for Fleet Workflows.

export type WorkflowProgram = 'pi' | 'claude';

export type WorkflowInput = {
  name: string;
  label: string;
  type: 'text' | 'pr' | 'issue';
  required: boolean;
};

/** What an agent may do. Fleet enforces it with program flags, not with prompt text. */
export type WorkflowAccess = 'read' | 'write';

export type WorkflowAgentDef = {
  role: string;
  program: WorkflowProgram;
  prompt: string;
  /** Only in a stage file. An old file's agents can always change code. */
  access?: WorkflowAccess;
  /** It talks with a person, so a turn end waits for them. */
  talks?: boolean;
  /** A person approves its plan before it changes code. */
  plan?: boolean;
  /** The role of an earlier agent whose session this agent goes on with. */
  resume?: string;
};

/** Agents in one stage run at the same time. The next stage waits for all of them. */
export type WorkflowStageDef = {
  name: string;
  agents: WorkflowAgentDef[];
  /** Skip this stage when the board is empty. */
  only_with_findings?: boolean;
};

export type WorkflowFinish = {
  action: 'save-report' | 'post-pr' | 'post-issue' | 'open-pr';
  path?: string;
};

export type WorkflowDef = {
  name: string;
  shared: string;
  board: boolean;
  workspace: 'current' | 'pr-worktree' | 'new-branch';
  inputs: WorkflowInput[];
  /** Empty in a stage file. Use `stagesOf` to read a file of either shape. */
  agents: WorkflowAgentDef[];
  judge?: WorkflowAgentDef;
  /** Set only in a stage file. */
  stages?: WorkflowStageDef[];
  finish?: WorkflowFinish;
};

/** Every file as stages. An old file's bytes do not change, so its approval holds. */
export function stagesOf(def: WorkflowDef): WorkflowStageDef[] {
  if (def.stages) return def.stages;
  const writers = (agents: WorkflowAgentDef[]): WorkflowAgentDef[] =>
    agents.map((agent) => ({ ...agent, access: 'write' }));
  const first = { name: 'Agents', agents: writers(def.agents) };
  return def.judge ? [first, { name: 'Last agent', agents: writers([def.judge]) }] : [first];
}

/** Every agent in run order, in a file of either shape. */
export function agentsOf(def: WorkflowDef): WorkflowAgentDef[] {
  return stagesOf(def).flatMap((stage) => stage.agents);
}

/** A file that stops for a person. It cannot run with nobody there. */
/** A role can repeat, so `resume` means the latest agent with that name. */
export function latestWithRole(
  stages: WorkflowStageDef[],
  role: string
): WorkflowAgentDef | undefined {
  return stages.flatMap((stage) => stage.agents).findLast((agent) => agent.role === role);
}

export function needsPersonAtRun(def: WorkflowDef): boolean {
  return agentsOf(def).some((agent) => agent.talks === true || agent.plan === true);
}

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

/** What a stopped agent can go on from: a file for Pi, a session id for Claude Code. */
export function agentChatHandle(agent: RunAgent): string | null {
  return agent.program === 'pi' ? agent.transcriptPath : agent.sessionId;
}

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
  /** The pane that stayed open, or opened again, after the run ended. */
  keptPaneId: string | null;
  autoRetried: boolean;
  /** Its stage skipped itself, so nothing went wrong. */
  stageSkipped?: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
  /** A permission request Fleet can answer for this agent. */
  pendingPermission: { toolUseId: string; tool: string } | null;
  /** Its place in the run order. A run from an older Fleet has no value here. */
  stage?: number;
  access?: WorkflowAccess;
  talks?: boolean;
  /** Its plan needs a person's approval before it can change code. */
  plan?: boolean;
  /** A person approved its plan. It is saved, so a restart keeps the limit until then. */
  planApproved?: boolean;
  /** The plan that waits for a person. */
  pendingPlan?: PendingPlan | null;
  /** Each plan the agent sent, oldest first. */
  plans?: PlanVersion[];
  /** The build mode a person chose for a Claude Code plan. */
  buildMode?: PlanBuildMode;
  /** The role of the agent whose session this agent goes on with. */
  resumes?: string;
};

export type PlanVersion = { version: number; path: string; at: number };

/** The mode a person approves a Claude Code plan into. */
export type PlanBuildMode = 'auto' | 'acceptEdits' | 'default';

export type PendingPlan = {
  version: number;
  /** The Claude Code request to answer. Pi has none. */
  toolUseId: string | null;
};

/** A person's answer on the plan page. */
export type PlanAnswer =
  | { kind: 'approve'; mode?: PlanBuildMode }
  | { kind: 'change'; text: string };

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
};

export type RunReport = {
  text: string;
  incomplete: boolean;
  /** The agents with no summary, for an Incomplete report. */
  missing: string[];
  savedTo: string | null;
  /** It went to the PR or the issue. A run from an older Fleet has no value here. */
  posted: boolean;
};

export type PrRef = {
  number: number;
  title: string;
  url: string;
  headSha: string;
  /** What the run reviewed moved on after it started. */
  movedOn: boolean;
};

/** The issue of a run. Its text is in the run folder, as a run record goes to the page. */
export type IssueRef = {
  number: number;
  title: string;
  url: string;
  state: string;
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
  /** The issue of an `issue` input. A run from an older Fleet has none. */
  issue?: IssueRef;
  /** A stranger's PR or issue. Agents start with read-only tools. */
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
  /** A team's PR in its own worktree, so agents approve their own tools. */
  teamPr: boolean;
  /** Stage names in run order. A run from an older Fleet has none. */
  stages?: string[];
  /** The workflow file has `stages`, and not the old `agents` shape. */
  stageFile?: boolean;
  /** The branch of a `new-branch` run. */
  branch?: RunBranch;
  /** The pull request an `open-pr` run opened. */
  openedPr?: { number: number; url: string };
  /** Why an `open-pr` run opened no pull request. */
  prProblem?: string;
};

export type PostTarget = { kind: 'pr' | 'issue'; number: number; label: string };

/** Where Post sends a report. `post-issue` means the issue, and else a PR goes first. */
export function postTarget(run: WorkflowRun): PostTarget | null {
  const { pr, issue } = run;
  if (issue && (run.finish?.action === 'post-issue' || !pr)) {
    return { kind: 'issue', number: issue.number, label: `issue #${issue.number}` };
  }
  return pr ? { kind: 'pr', number: pr.number, label: `PR #${pr.number}` } : null;
}

/** A rerun reads an issue again and it can hold new comments, so the authors get a new check. */
export function trustsOnRerun(run: WorkflowRun): boolean {
  return !run.locked && !run.issue;
}

/** A run from an older Fleet has no stage: its last agent came after all others. */
export function stageOf(agent: RunAgent): number {
  return agent.stage ?? (agent.isLast ? 1 : 0);
}

export function agentsInStage(run: WorkflowRun, stage: number): RunAgent[] {
  return run.agents.filter((agent) => stageOf(agent) === stage);
}

export type RunBranch = {
  name: string;
  /** The default branch, for the pull request. */
  base: string;
  /** The commit the branch started from. */
  baseSha: string;
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
  /** A builder tab: its second split shows this session's draft. */
  builderId?: string;
};

/** A builder pane and the one draft it makes. */
export type BuilderInfo = {
  id: string;
  projectPath: string;
  program: WorkflowProgram;
  /** The file name without `.toml`. Null until the first save. */
  draftId: string | null;
};

/** A saved agent definition, for the job list of Add agent. */
export type SavedAgent = {
  name: string;
  description: string;
  prompt: string;
  access: WorkflowAccess;
};

export type BuilderStart = { ok: true; id: string } | { ok: false; message: string };

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
  /** The file that an agent made, on an `agent-create` notice. */
  workflowId?: string;
  /** The agent whose plan waits, on a `needs-you` notice. */
  planAgentId?: string;
};

export type WorkflowsState = {
  runs: WorkflowRun[];
  rules: WorkflowRule[];
  away: AwayEntry[];
  notices: WorkflowNotice[];
  limits: WorkflowLimits;
};

/** A push from main: the workflow files of the project that the page shows. */
export type WorkflowEntries = {
  projectPath: string;
  entries: WorkflowEntry[];
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
  /** The issue the run would use, once its input is known. */
  issue: (IssueRef & { locked: boolean }) | null;
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
  /** Treat a stranger's PR or issue as the team's, for this run. */
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
export type OpenAgentResult = { ok: true; paneId: string } | { ok: false; reason: string };

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
  openAgent: (runId: string, agentId: string) => Promise<OpenAgentResult>;
  retryPrepare: (runId: string) => void;
  answerPermission: (toolUseId: string, decision: 'allow' | 'deny') => boolean;
  /** What is wrong in a file, in the words that Save would use. */
  check: (text: string) => string | null;
  savedAgents: (projectPath: string) => Promise<SavedAgent[]>;
  startBuilder: (projectPath: string, program: WorkflowProgram) => Promise<BuilderStart>;
  reopenBuilder: (projectPath: string, draftId: string) => Promise<BuilderStart>;
  builderInfo: (id: string) => BuilderInfo | null;
  draftsWithBuilder: (projectPath: string) => string[];
  programs: () => Promise<Record<WorkflowProgram, boolean>>;
  answerPlan: (runId: string, agentId: string, answer: PlanAnswer) => Promise<boolean>;
  readPlan: (runId: string, version: number) => string | null;
  retryPr: (runId: string) => Promise<void>;
  reportPath: (runId: string) => string | null;
  saveReport: (runId: string, path: string, replace: boolean) => SaveReportResult;
  pickReportPath: (runId: string) => Promise<SaveReportResult | null>;
  post: (runId: string) => Promise<void>;
  dismissNotice: (id: string) => void;
  answerAsk: (id: string, allow: boolean) => void;
  saveRule: (rule: RuleInput) => WorkflowRule;
  deleteRule: (id: string) => void;
  setRuleEnabled: (id: string, enabled: boolean) => void;
  runRule: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  setLimits: (limits: WorkflowLimits) => void;
  clearAway: () => void;
};
