import { useState } from 'react';
import type {
  RuleInput,
  RuleMissed,
  RuleTrigger,
  WorkflowEntry,
  WorkflowRule
} from '../../../../shared/workflows';
import { agentsOf, findWorkflow, runsPerDay } from '../../../../shared/workflows';
import { callWorkflows, useWorkflowsStore } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Button, CountInput, Field, FIELD_CLASS } from './parts';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEK_DAYS = [1, 2, 3, 4, 5];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const SHORTEST_MINUTES = 5;
const DEFAULT_DAILY_LIMIT = 100;

type Kind = RuleTrigger['kind'];

const KINDS: Array<{ id: Kind; label: string }> = [
  { id: 'time', label: 'At a time' },
  { id: 'interval', label: 'On a repeat' },
  { id: 'new-pr', label: 'On each new PR' }
];

function defaultTrigger(kind: Kind): RuleTrigger {
  if (kind === 'time') return { kind, at: '09:00', days: WEEK_DAYS };
  if (kind === 'interval') return { kind, minutes: 30, days: WEEK_DAYS, window: null };
  return { kind, includeStrangers: false, includeDrafts: false };
}

function DayPicker({
  days,
  onChange
}: {
  days: number[];
  onChange: (days: number[]) => void;
}): React.JSX.Element {
  const toggle = (day: number): void => {
    onChange(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort());
  };
  return (
    <Field label="Days">
      <span className="flex gap-1">
        {ALL_DAYS.map((day) => (
          <button
            key={day}
            type="button"
            aria-label={`Day ${day}`}
            aria-pressed={days.includes(day)}
            onClick={() => toggle(day)}
            className={`h-7 w-7 rounded text-[11px] ${
              days.includes(day)
                ? 'bg-[var(--fleet-accent)] text-white'
                : 'bg-fleet-surface-2 text-fleet-text-subtle'
            }`}
          >
            {DAY_LABELS[day]}
          </button>
        ))}
      </span>
    </Field>
  );
}

function IntervalFields({
  trigger,
  onChange
}: {
  trigger: Extract<RuleTrigger, { kind: 'interval' }>;
  onChange: (trigger: RuleTrigger) => void;
}): React.JSX.Element {
  const hours = trigger.minutes % 60 === 0 && trigger.minutes >= 60;
  const shown = hours ? trigger.minutes / 60 : trigger.minutes;
  const setMinutes = (value: number, inHours: boolean): void => {
    const minutes = inHours ? value * 60 : value;
    onChange({ ...trigger, minutes: Math.max(SHORTEST_MINUTES, minutes) });
  };
  const { window } = trigger;
  return (
    <>
      <div className="flex items-end gap-2">
        <Field label="Every">
          <input
            type="number"
            min={1}
            className={`${FIELD_CLASS} w-24`}
            value={shown}
            onChange={(e) => setMinutes(Number(e.target.value), hours)}
          />
        </Field>
        <select
          aria-label="Unit"
          className={`${FIELD_CLASS} w-28`}
          value={hours ? 'hours' : 'minutes'}
          onChange={(e) => setMinutes(shown, e.target.value === 'hours')}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
        </select>
      </div>
      <DayPicker days={trigger.days} onChange={(days) => onChange({ ...trigger, days })} />
      <label className="flex items-center gap-2 text-xs text-fleet-text-secondary">
        <input
          type="checkbox"
          checked={window !== null}
          onChange={(e) =>
            onChange({
              ...trigger,
              window: e.target.checked ? { from: '09:00', to: '18:00' } : null
            })
          }
        />
        Only between
      </label>
      {window && (
        <div className="flex items-center gap-2 text-xs text-fleet-text-muted">
          <input
            aria-label="From"
            type="time"
            className={`${FIELD_CLASS} w-28`}
            value={window.from}
            onChange={(e) => onChange({ ...trigger, window: { ...window, from: e.target.value } })}
          />
          and
          <input
            aria-label="To"
            type="time"
            className={`${FIELD_CLASS} w-28`}
            value={window.to}
            onChange={(e) => onChange({ ...trigger, window: { ...window, to: e.target.value } })}
          />
        </div>
      )}
    </>
  );
}

function TriggerFields({
  trigger,
  onChange
}: {
  trigger: RuleTrigger;
  onChange: (trigger: RuleTrigger) => void;
}): React.JSX.Element {
  if (trigger.kind === 'interval') return <IntervalFields trigger={trigger} onChange={onChange} />;
  if (trigger.kind === 'time') {
    return (
      <>
        <Field label="Time">
          <input
            type="time"
            className={`${FIELD_CLASS} w-28`}
            value={trigger.at}
            onChange={(e) => onChange({ ...trigger, at: e.target.value })}
          />
        </Field>
        <DayPicker days={trigger.days} onChange={(days) => onChange({ ...trigger, days })} />
      </>
    );
  }
  return (
    <div className="space-y-1.5 text-xs text-fleet-text-secondary">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={trigger.includeStrangers}
          onChange={(e) => onChange({ ...trigger, includeStrangers: e.target.checked })}
        />
        Add PRs from outside the team. Those runs are locked.
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={trigger.includeDrafts}
          onChange={(e) => onChange({ ...trigger, includeDrafts: e.target.checked })}
        />
        Add draft PRs
      </label>
    </div>
  );
}

function agentsIn(entry: WorkflowEntry | undefined): number {
  const def = entry?.def;
  return def ? agentsOf(def).length : 0;
}

function previewText(trigger: RuleTrigger, agents: number): string {
  if (trigger.kind === 'new-pr') return `One run with ${agents} agents for each new PR.`;
  const count = runsPerDay(trigger);
  const runs = count === 1 ? 'run' : 'runs';
  const team = agents === 1 ? '1 agent' : `${agents} agents`;
  return `About ${count} ${runs} a day, with ${team} each.`;
}

/** Why the rule's own file cannot start now. */
function waitOf(entry: WorkflowEntry): string {
  if (entry.disabled) return ' - turned off';
  if (entry.def === null) return ' - bad file';
  if (entry.approval !== 'approved') return ' - needs approval';
  return '';
}

export function RuleForm({
  projectPath,
  rule,
  onClose
}: {
  projectPath: string;
  rule: WorkflowRule | null;
  onClose: () => void;
}): React.JSX.Element {
  const entries = useWorkflowsStore((s) => s.entries);
  // The rule's own file stays a choice when it cannot start now, so a save never swaps it.
  const own = rule ? findWorkflow(entries, rule.workflowId, rule.workflowScope) : undefined;
  const usable = entries.filter(
    (entry) =>
      entry === own || (entry.def !== null && entry.approval === 'approved' && !entry.disabled)
  );
  // A path, not an id: a project and a personal file can share an id.
  const [pickedPath, setPickedPath] = useState(own?.path ?? null);
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<RuleTrigger>(rule?.trigger ?? defaultTrigger('interval'));
  const [inputs, setInputs] = useState<Record<string, string>>(rule?.inputs ?? {});
  const [missed, setMissed] = useState<RuleMissed>(rule?.missed ?? 'run-once');
  const [dailyLimit, setDailyLimit] = useState(rule?.dailyLimit ?? DEFAULT_DAILY_LIMIT);

  const entry = usable.find((candidate) => candidate.path === pickedPath) ?? usable.at(0);
  const workflowId = entry?.id ?? rule?.workflowId ?? '';
  const shared = (id: string): boolean => usable.filter((each) => each.id === id).length > 1;
  const ruleInputs = (entry?.def?.inputs ?? []).filter(
    (input) => !(trigger.kind === 'new-pr' && input.type === 'pr')
  );
  const empty = ruleInputs.some(
    (input) => input.required && (inputs[input.name] ?? '').trim() === ''
  );

  const save = async (): Promise<void> => {
    const input: RuleInput = {
      id: rule?.id,
      name: name.trim() || entry?.def?.name || workflowId,
      projectPath,
      workflowId,
      workflowScope: entry?.scope ?? rule?.workflowScope,
      inputs,
      trigger,
      missed,
      enabled: rule?.enabled ?? true,
      pausedReason: rule?.pausedReason ?? null,
      dailyLimit
    };
    await callWorkflows('saveRule', input);
    useToastStore.getState().show('Automatic run saved.');
    onClose();
  };

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <Field label="Workflow">
        <select
          className={FIELD_CLASS}
          value={entry?.path ?? ''}
          onChange={(e) => setPickedPath(e.target.value)}
        >
          {usable.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.def?.name ?? candidate.id}
              {shared(candidate.id) &&
                (candidate.scope === 'project' ? ' (Project)' : ' (Personal)')}
              {waitOf(candidate)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input
          className={FIELD_CLASS}
          placeholder={entry?.def?.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div className="flex gap-1">
        {KINDS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTrigger(defaultTrigger(id))}
            className={`rounded px-2.5 py-1 text-xs ${
              trigger.kind === id
                ? 'bg-fleet-surface-2 text-fleet-text'
                : 'text-fleet-text-subtle hover:bg-fleet-surface-2/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <TriggerFields trigger={trigger} onChange={setTrigger} />

      {ruleInputs.map((input) => (
        <Field
          key={input.name}
          label={input.label}
          hint="Each automatic run uses this text, because nobody is there to type it."
        >
          <textarea
            rows={2}
            className={`${FIELD_CLASS} resize-none`}
            value={inputs[input.name] ?? ''}
            onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.value })}
          />
        </Field>
      ))}

      <Field label="If the computer is asleep at that time">
        <select
          className={FIELD_CLASS}
          value={missed}
          onChange={(e) => setMissed(e.target.value === 'skip' ? 'skip' : 'run-once')}
        >
          <option value="run-once">Run once when I come back</option>
          <option value="skip">Skip it</option>
        </select>
      </Field>
      <Field label="Runs a day, at most">
        <CountInput className="w-24" value={dailyLimit} onChange={setDailyLimit} />
      </Field>

      <p className="text-xs text-fleet-text-secondary">{previewText(trigger, agentsIn(entry))}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-fleet-text-subtle">
        <li>Nothing posts by itself. Findings and reports wait for you in Fleet.</li>
        <li>If a run is still going at the next start, Fleet skips that start.</li>
        <li>If an agent asks for permission, the run waits. Fleet does not answer for you.</li>
        <li>If the workflow file changes, this rule stops until you approve the change.</li>
      </ul>

      <div className="flex justify-end gap-2 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" disabled={!entry || empty} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
