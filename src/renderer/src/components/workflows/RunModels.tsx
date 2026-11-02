import { switchProgram, type ModelChoice } from '../../../../shared/workflow-models';
import {
  agentsOf,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowProgram
} from '../../../../shared/workflows';
import { ModelFields } from './agent-fields';
import { PROGRAM_LABELS } from './workflow-review';

export type ModelChoices = Record<string, ModelChoice>;

/** One row per role: an agent that comes back with its own role shares the row. */
function firstOfEachRole(def: WorkflowDef): WorkflowAgentDef[] {
  const byRole = new Map<string, WorkflowAgentDef>();
  for (const agent of agentsOf(def)) if (!byRole.has(agent.role)) byRole.set(agent.role, agent);
  return [...byRole.values()];
}

/**
 * The model and effort of each agent, for this run only. Each row starts from the
 * file, as Fleet would run it with the program the run uses.
 */
export function RunModels({
  def,
  programOverride,
  value,
  onChange
}: {
  def: WorkflowDef;
  programOverride?: WorkflowProgram;
  value: ModelChoices;
  onChange: (choices: ModelChoices) => void;
}): React.JSX.Element {
  const agents = firstOfEachRole(def).map((agent) =>
    programOverride ? switchProgram(agent, programOverride) : agent
  );
  const changed = Object.keys(value).length;
  return (
    <details className="rounded border border-fleet-border">
      <summary className="flex cursor-pointer select-none items-center justify-between px-2.5 py-2 text-[11px] font-medium text-fleet-text-muted">
        Models for this run
        <span className="font-normal text-fleet-text-subtle">
          {changed === 0 ? 'As in the file' : `${changed} changed for this run`}
        </span>
      </summary>
      <div className="space-y-3 border-t border-fleet-border px-2.5 py-3">
        {agents.map((agent) => (
          <div key={agent.role} className="space-y-1.5">
            <div className="text-[11px] text-fleet-text-secondary">
              {agent.role}
              <span className="text-fleet-text-subtle"> · {PROGRAM_LABELS[agent.program]}</span>
            </div>
            <ModelFields
              program={agent.program}
              value={value[agent.role] ?? { model: agent.model, effort: agent.effort }}
              inheritsFrom={agent.resume}
              onChange={(choice) => onChange({ ...value, [agent.role]: choice })}
            />
          </div>
        ))}
        <p className="text-[11px] text-fleet-text-subtle">
          This changes only this run. The file stays as you approved it.
        </p>
      </div>
    </details>
  );
}
