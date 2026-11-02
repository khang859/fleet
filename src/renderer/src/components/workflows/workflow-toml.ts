import { parse, stringify } from 'smol-toml';
import {
  latestWithRole,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowFinish,
  type WorkflowInput,
  type WorkflowStageDef
} from '../../../../shared/workflows';

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

function agentOf(raw: Record<string, unknown>): WorkflowAgentDef {
  return {
    role: textOf(raw.role),
    program: raw.program === 'claude' ? 'claude' : 'pi',
    prompt: textOf(raw.prompt)
  };
}

export function inputTypeOf(value: unknown): WorkflowInput['type'] {
  return value === 'pr' || value === 'issue' ? value : 'text';
}

function inputOf(raw: Record<string, unknown>): WorkflowInput {
  return {
    name: textOf(raw.name),
    label: textOf(raw.label),
    type: inputTypeOf(raw.type),
    required: raw.required !== false
  };
}

/** As in main: `resume` gives an agent the program and access of the named agent. */
function stageAgentOf(raw: Record<string, unknown>, earlier: WorkflowStageDef[]): WorkflowAgentDef {
  const resume = typeof raw.resume === 'string' ? raw.resume : undefined;
  const target = resume === undefined ? undefined : latestWithRole(earlier, resume);
  const access = raw.access === 'write' || raw.access === 'read' ? raw.access : undefined;
  return {
    ...agentOf(raw),
    program: target?.program ?? agentOf(raw).program,
    access: access ?? target?.access ?? 'read',
    talks: raw.talks === true ? true : undefined,
    plan: raw.plan === true ? true : undefined,
    resume
  };
}

function stagesFrom(raw: unknown): WorkflowStageDef[] {
  const stages: WorkflowStageDef[] = [];
  for (const stage of recordsOf(raw)) {
    stages.push({
      name: textOf(stage.name),
      only_with_findings: stage.only_with_findings === true ? true : undefined,
      agents: recordsOf(stage.agents).map((agent) => stageAgentOf(agent, stages))
    });
  }
  return stages;
}

const FINISH_ACTIONS = ['post-pr', 'post-issue', 'open-pr'] as const;

function finishOf(raw: Record<string, unknown> | undefined): WorkflowFinish | undefined {
  if (!raw) return undefined;
  const action = FINISH_ACTIONS.find((known) => known === raw.action) ?? 'save-report';
  return { action, path: typeof raw.path === 'string' ? raw.path : undefined };
}

export function workspaceOf(value: unknown): WorkflowDef['workspace'] {
  return value === 'pr-worktree' || value === 'new-branch' ? value : 'current';
}

/** The form's view of a file. Main checks the file itself when it saves. */
export function parseToForm(text: string): WorkflowDef {
  const raw = parse(text);
  const judge = recordsOf([raw.judge]).at(0);
  const def: WorkflowDef = {
    name: textOf(raw.name),
    shared: textOf(raw.shared),
    board: raw.board !== false,
    workspace: workspaceOf(raw.workspace),
    inputs: recordsOf(raw.inputs).map(inputOf),
    agents: recordsOf(raw.agents).map(agentOf),
    judge: judge ? agentOf(judge) : undefined,
    finish: finishOf(recordsOf([raw.finish]).at(0))
  };
  return 'stages' in raw ? { ...def, stages: stagesFrom(raw.stages) } : def;
}

/** A key with no value is left out, as TOML has no empty value. */
function clean<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** A returning agent takes its program from its session, so the file does not repeat it. */
function stageAgentToml(agent: WorkflowAgentDef): Record<string, unknown> {
  const { role, program, access, talks, plan, resume, prompt } = agent;
  const shown = resume === undefined ? program : undefined;
  return clean({ role, program: shown, access, talks, plan, resume, prompt });
}

function stageToml(stage: WorkflowStageDef): Record<string, unknown> {
  const { name, only_with_findings: onlyWithFindings, agents } = stage;
  return clean({
    name,
    only_with_findings: onlyWithFindings,
    agents: agents.map(stageAgentToml)
  });
}

export function formToToml(def: WorkflowDef): string {
  const staged = def.stages !== undefined;
  return stringify(
    clean({
      name: def.name,
      shared: def.shared,
      board: def.board,
      workspace: def.workspace,
      inputs: def.inputs.map(clean),
      agents: staged ? undefined : def.agents.map(clean),
      judge: !staged && def.judge ? clean(def.judge) : undefined,
      stages: def.stages?.map(stageToml),
      finish: def.finish && clean(def.finish)
    })
  );
}
