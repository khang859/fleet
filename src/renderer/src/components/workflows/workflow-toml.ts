import { parse, stringify } from 'smol-toml';
import type { WorkflowAgentDef, WorkflowDef, WorkflowInput } from '../../../../shared/workflows';

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

function inputOf(raw: Record<string, unknown>): WorkflowInput {
  return {
    name: textOf(raw.name),
    label: textOf(raw.label),
    type: raw.type === 'pr' ? 'pr' : 'text',
    required: raw.required !== false
  };
}

/** The form's view of a file. Main checks the file itself when it saves. */
export function parseToForm(text: string): WorkflowDef {
  const raw = parse(text);
  const judge = recordsOf([raw.judge]).at(0);
  const finish = recordsOf([raw.finish]).at(0);
  return {
    name: textOf(raw.name),
    shared: textOf(raw.shared),
    board: raw.board !== false,
    workspace: raw.workspace === 'pr-worktree' ? 'pr-worktree' : 'current',
    inputs: recordsOf(raw.inputs).map(inputOf),
    agents: recordsOf(raw.agents).map(agentOf),
    judge: judge ? agentOf(judge) : undefined,
    finish: finish
      ? {
          action: finish.action === 'post-pr' ? 'post-pr' : 'save-report',
          path: typeof finish.path === 'string' ? finish.path : undefined
        }
      : undefined
  };
}

/** A key with no value is left out, as TOML has no empty value. */
function clean<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function formToToml(def: WorkflowDef): string {
  return stringify(
    clean({
      name: def.name,
      shared: def.shared,
      board: def.board,
      workspace: def.workspace,
      inputs: def.inputs.map(clean),
      agents: def.agents.map(clean),
      judge: def.judge && clean(def.judge),
      finish: def.finish && clean(def.finish)
    })
  );
}
