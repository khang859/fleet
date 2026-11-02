import { useState } from 'react';
import { EFFORT_LEVELS, MODEL_PATTERN, type ModelChoice } from '../../../../shared/workflow-models';
import type {
  WorkflowAccess,
  WorkflowAgentDef,
  WorkflowProgram
} from '../../../../shared/workflows';
import { Field, FIELD_CLASS } from './parts';
import { useModels, type Programs } from './use-programs';
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

/** The select value that opens a text box for a model the list does not have. */
const OTHER_MODEL = '\u0000other';

const MODEL_EXAMPLES: Record<WorkflowProgram, string> = {
  claude: 'claude-opus-5-5',
  pi: 'provider/model'
};

function modelHint(model: string | undefined): string | undefined {
  return model !== undefined && !MODEL_PATTERN.test(model)
    ? 'This is not a model name.'
    : undefined;
}

function ModelField({
  program,
  value,
  unsetLabel,
  onChange
}: {
  program: WorkflowProgram;
  value: string | undefined;
  unsetLabel: string;
  onChange: (model: string | undefined) => void;
}): React.JSX.Element {
  const models = useModels(program);
  const [typing, setTyping] = useState(false);
  // Until the list comes, a set model counts as known, so its text box does not flash.
  const known = value === undefined || models === null || models.includes(value);
  const custom = typing || !known;
  const pick = (picked: string): void => {
    setTyping(picked === OTHER_MODEL);
    if (picked !== OTHER_MODEL) onChange(picked === '' ? undefined : picked);
  };
  return (
    <Field label="Model" hint={modelHint(value)}>
      <select
        className={FIELD_CLASS}
        value={custom ? OTHER_MODEL : (value ?? '')}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">{unsetLabel}</option>
        {(models ?? (value === undefined ? [] : [value])).map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={OTHER_MODEL}>Other…</option>
      </select>
      {custom && (
        <input
          className={FIELD_CLASS}
          value={value ?? ''}
          placeholder={MODEL_EXAMPLES[program]}
          aria-label="Model name"
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * The model and effort an agent runs with. Unset uses the program default, or,
 * with `inheritsFrom`, the choice of the agent it goes on from.
 */
export function ModelFields({
  program,
  value,
  inheritsFrom,
  onChange
}: {
  program: WorkflowProgram;
  value: ModelChoice;
  inheritsFrom?: string;
  onChange: (choice: ModelChoice) => void;
}): React.JSX.Element {
  const unsetLabel = inheritsFrom ? `Same as ${inheritsFrom}` : 'Program default';
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* A new program has other models, so an open text box starts over. */}
      <ModelField
        key={program}
        program={program}
        value={value.model}
        unsetLabel={unsetLabel}
        onChange={(model) => onChange({ ...value, model })}
      />
      <Field label="Effort">
        <select
          className={FIELD_CLASS}
          value={value.effort ?? ''}
          onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
        >
          <option value="">{unsetLabel}</option>
          {EFFORT_LEVELS[program].map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
