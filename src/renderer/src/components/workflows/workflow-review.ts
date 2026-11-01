import { diffLines, type DiffOp } from '../../../../shared/agent-diff';
import {
  agentsOf,
  stagesOf,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowEntry,
  type WorkflowProgram
} from '../../../../shared/workflows';
import { parseToForm } from './workflow-toml';

export const PROGRAM_LABELS: Record<WorkflowProgram, string> = {
  pi: 'Pi',
  claude: 'Claude Code'
};

export type ReviewLine = { sign: '+' | '-' | ' '; text: string };

export type ReviewStatus = 'same' | 'changed' | 'new' | 'removed';

export type ReviewSetting = {
  label: string;
  value: string;
  /** The approved value, when it is not the same. */
  was?: string;
};

export type ReviewAgent = {
  /** The same role can come back in a later stage, so the role is not a key. */
  id: string;
  role: string;
  /** Set in a stage file. */
  stage?: string;
  access?: WorkflowAgentDef['access'];
  talks?: boolean;
  plan?: boolean;
  resume?: string;
  program: WorkflowProgram;
  /** The approved program, when it is not the same. */
  wasProgram?: WorkflowProgram;
  last: boolean;
  status: ReviewStatus;
  lines: ReviewLine[];
};

export type WorkflowReview = {
  settings: ReviewSetting[];
  shared: ReviewLine[];
  agents: ReviewAgent[];
};

type RuleKeys = 'id' | 'role' | 'stage' | 'access' | 'talks' | 'plan' | 'resume';

type RosterAgent = WorkflowAgentDef & { id: string; last: boolean; stage?: string };

const SIGNS: Record<DiffOp['kind'], ReviewLine['sign']> = {
  add: '+',
  remove: '-',
  context: ' '
};

function lineDiff(oldText: string, newText: string): ReviewLine[] {
  return diffLines(oldText, newText).map((op) => ({ sign: SIGNS[op.kind], text: op.text }));
}

export function hasChange(lines: ReviewLine[]): boolean {
  return lines.some((line) => line.sign !== ' ');
}

export function whereText(def: WorkflowDef): string {
  if (def.workspace === 'new-branch') return 'A new branch, in a new worktree';
  return def.workspace === 'pr-worktree' ? 'A new worktree for the PR' : 'The project folder';
}

function inputsText(def: WorkflowDef): string {
  if (def.inputs.length === 0) return 'None';
  return def.inputs
    .map((input) => {
      const type = input.type === 'pr' ? 'PR' : 'text';
      const need = input.required ? 'required' : 'optional';
      return `${input.label} - {{${input.name}}} (${type}, ${need})`;
    })
    .join('\n');
}

function finishText(def: WorkflowDef): string {
  if (!def.finish) return 'Show the report in Fleet';
  if (def.finish.action === 'post-pr') return 'Offer to post the findings on the PR';
  if (def.finish.action === 'open-pr') return 'Push the branch and open a pull request';
  return def.finish.path ? `Save the report to ${def.finish.path}` : 'Save the report';
}

/** Fleet posts with the first agent's program, so a new agent order can change who posts. */
function postingText(def: WorkflowDef): string {
  return `${PROGRAM_LABELS[agentsOf(def)[0].program]} posts the findings`;
}

function settingRows(def: WorkflowDef): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Name', def.name],
    ['Where', whereText(def)],
    ['Inputs', inputsText(def)],
    ['Board', def.board ? 'On - agents share their findings' : 'Off'],
    ['Finish', finishText(def)]
  ];
  const hasPr = def.inputs.some((input) => input.type === 'pr');
  return hasPr ? [...rows, ['Posting', postingText(def)]] : rows;
}

/** The sheet title already holds the name, so its row shows only a change. */
function reviewSettings(def: WorkflowDef, before: WorkflowDef): ReviewSetting[] {
  const oldRows = new Map(settingRows(before));
  return settingRows(def)
    .map(([label, value]) => {
      const old = oldRows.get(label);
      return old === value ? { label, value } : { label, value, was: old };
    })
    .filter((row) => row.label !== 'Name' || row.was !== undefined);
}

function stageRoster(def: WorkflowDef): RosterAgent[] {
  const stages = stagesOf(def);
  const roster = stages.flatMap((stage) =>
    stage.agents.map((agent) => ({ ...agent, stage: stage.name, last: false, id: '' }))
  );
  const lastStage = stages[stages.length - 1];
  const count = new Map<string, number>();
  return roster.map((agent) => {
    const turn = (count.get(agent.role) ?? 0) + 1;
    count.set(agent.role, turn);
    const last = lastStage.agents.length === 1 && agent === roster[roster.length - 1];
    return { ...agent, id: turn === 1 ? agent.role : `${agent.role}#${turn}`, last };
  });
}

function roster(def: WorkflowDef): RosterAgent[] {
  if (def.stages) return stageRoster(def);
  const agents = def.agents.map((agent) => ({ ...agent, id: agent.role, last: false }));
  return def.judge ? [...agents, { ...def.judge, id: def.judge.role, last: true }] : agents;
}

/** A new access, chat or plan rule can change what an agent may do, so it counts as a change. */
function movedRules(agent: RosterAgent, old: RosterAgent): boolean {
  const rules = (each: RosterAgent): string =>
    JSON.stringify([each.access ?? 'write', !!each.talks, !!each.plan, each.resume ?? null]);
  return rules(agent) !== rules(old) || agent.stage !== old.stage;
}

function ruleFields(agent: RosterAgent): Pick<ReviewAgent, RuleKeys> {
  const { id, role, stage, access, talks, plan, resume } = agent;
  return { id, role, stage, access, talks, plan, resume };
}

function reviewAgent(agent: RosterAgent, old: RosterAgent | undefined): ReviewAgent {
  const lines = lineDiff(old?.prompt ?? '', agent.prompt);
  const movedProgram = old !== undefined && old.program !== agent.program;
  const movedRule = old !== undefined && movedRules(agent, old);
  const changed = hasChange(lines) || movedProgram || movedRule || old?.last !== agent.last;
  return {
    ...ruleFields(agent),
    program: agent.program,
    wasProgram: movedProgram ? old.program : undefined,
    last: agent.last,
    status: old === undefined ? 'new' : changed ? 'changed' : 'same',
    lines
  };
}

function removedAgent(agent: RosterAgent): ReviewAgent {
  return {
    ...ruleFields(agent),
    program: agent.program,
    last: agent.last,
    status: 'removed',
    lines: lineDiff(agent.prompt, '')
  };
}

/** A new file has nothing to compare, so it is compared with itself and shows no change. */
export function buildReview(def: WorkflowDef, approved: WorkflowDef | null): WorkflowReview {
  const before = approved ?? def;
  const oldAgents = new Map(roster(before).map((agent) => [agent.id, agent]));
  const ids = new Set(roster(def).map((agent) => agent.id));
  return {
    settings: reviewSettings(def, before),
    shared: lineDiff(before.shared, def.shared),
    agents: [
      ...roster(def).map((agent) => reviewAgent(agent, oldAgents.get(agent.id))),
      ...roster(before)
        .filter((agent) => !ids.has(agent.id))
        .map(removedAgent)
    ]
  };
}

/** The sections for an entry, or null when only the raw file can show it. */
export function reviewOf(entry: WorkflowEntry): WorkflowReview | null {
  if (!entry.def) return null;
  if (entry.approvedText === null) return buildReview(entry.def, null);
  try {
    return buildReview(entry.def, parseToForm(entry.approvedText));
  } catch {
    // The approved text no longer parses, so only a line compare can show the change.
    return null;
  }
}

/** The raw file, with the change marked when an approved version exists. */
export function fileLines(approvedText: string | null, text: string): ReviewLine[] {
  return lineDiff(approvedText ?? text, text);
}

function agentWord(count: number): string {
  return count === 1 ? 'agent' : 'agents';
}

/** One line for the top of the sheet, so a person knows where to look. */
export function reviewSummary(review: WorkflowReview): string {
  const count = (status: ReviewStatus): number =>
    review.agents.filter((agent) => agent.status === status).length;

  const parts = [
    count('changed') > 0 && `${count('changed')} ${agentWord(count('changed'))} changed`,
    count('new') > 0 && `${count('new')} new ${agentWord(count('new'))}`,
    count('removed') > 0 && `${count('removed')} ${agentWord(count('removed'))} removed`,
    hasChange(review.shared) && 'Shared instructions changed',
    review.settings.some((setting) => setting.was !== undefined) && 'Settings changed'
  ].filter((part) => part !== false);

  if (parts.length === 0) return 'Only comments, spacing or order changed.';
  return `${parts.join('. ')}.`;
}
