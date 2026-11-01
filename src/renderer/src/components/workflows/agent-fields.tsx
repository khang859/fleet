import type {
  WorkflowAccess,
  WorkflowAgentDef,
  WorkflowProgram
} from '../../../../shared/workflows';
import { Field, FIELD_CLASS } from './parts';
import type { Programs } from './use-programs';
import { PROGRAM_LABELS } from './workflow-review';

function programLabel(program: WorkflowProgram, programs: Programs): string {
  return programs[program] ? PROGRAM_LABELS[program] : `${PROGRAM_LABELS[program]} (not installed)`;
}

export function ProgramField({
  programs,
  value,
  disabled = false,
  hint,
  onChange
}: {
  programs: Programs;
  value: WorkflowProgram;
  disabled?: boolean;
  hint?: string;
  onChange: (program: WorkflowProgram) => void;
}): React.JSX.Element {
  return (
    <Field label="Program" hint={hint}>
      <select
        className={FIELD_CLASS}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'claude' ? 'claude' : 'pi')}
      >
        <option value="claude">{programLabel('claude', programs)}</option>
        <option value="pi">{programLabel('pi', programs)}</option>
      </select>
    </Field>
  );
}

function CheckRow({
  label,
  checked,
  disabled = false,
  hint,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-start gap-2 text-xs text-fleet-text-secondary">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={disabled ? 'opacity-60' : ''}>
        {label}
        {hint && <span className="block text-[11px] text-fleet-text-subtle">{hint}</span>}
      </span>
    </label>
  );
}

/** What an agent may do. Plan approval stops code changes, so it needs them to stop. */
export function AgentAccessFields({
  agent,
  onChange
}: {
  agent: WorkflowAgentDef;
  onChange: (agent: WorkflowAgentDef) => void;
}): React.JSX.Element {
  const setAccess = (access: WorkflowAccess): void => {
    onChange({ ...agent, access, plan: access === 'write' ? agent.plan : undefined });
  };
  const canWrite = agent.access === 'write';
  return (
    <div className="space-y-2">
      <Field label="May do">
        <select
          className={FIELD_CLASS}
          value={agent.access ?? 'read'}
          onChange={(e) => setAccess(e.target.value === 'write' ? 'write' : 'read')}
        >
          <option value="read">Read only</option>
          <option value="write">Change code</option>
        </select>
      </Field>
      <CheckRow
        label="Talks with a person"
        hint="Fleet waits for you. This file cannot run from an automatic rule."
        checked={agent.talks === true}
        onChange={(talks) => onChange({ ...agent, talks: talks || undefined })}
      />
      <CheckRow
        label="A person approves its plan first"
        hint={canWrite ? 'It cannot change code before that.' : 'This needs Change code.'}
        checked={agent.plan === true}
        disabled={!canWrite}
        onChange={(plan) => onChange({ ...agent, plan: plan || undefined })}
      />
    </div>
  );
}
