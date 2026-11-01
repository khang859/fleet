import { useState } from 'react';
import { Pencil, Play, Trash2 } from 'lucide-react';
import type { RuleTrigger, WorkflowLimits, WorkflowRule } from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError, useWorkflowsStore } from '../../store/workflows-store';
import { AwayPanel } from './AwayPanel';
import { Badge, Button, CountInput, Empty, Field } from './parts';
import { formatAgo } from './workflow-format';
import { RuleForm } from './RuleForm';
import { useRunRule } from './use-run-rule';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function daysText(days: number[]): string {
  if (days.length === 7) return 'every day';
  return days.map((day) => DAY_NAMES[day]).join(', ');
}

function whenText(trigger: RuleTrigger): string {
  if (trigger.kind === 'new-pr') return 'On each new PR';
  if (trigger.kind === 'time') return `At ${trigger.at}, ${daysText(trigger.days)}`;
  const span = trigger.window ? `, ${trigger.window.from} to ${trigger.window.to}` : '';
  return `Every ${trigger.minutes} min, ${daysText(trigger.days)}${span}`;
}

function RuleRow({
  rule,
  onEdit,
  onRun
}: {
  rule: WorkflowRule;
  onEdit: () => void;
  onRun: () => unknown;
}): React.JSX.Element {
  return (
    <div className="group flex items-center gap-3 border-b border-fleet-border px-4 py-2.5 last:border-b-0">
      <input
        aria-label={`Turn ${rule.name} on or off`}
        type="checkbox"
        checked={rule.enabled}
        onChange={(e) => {
          callWorkflows('setRuleEnabled', rule.id, e.target.checked).catch(showWorkflowError);
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-fleet-text">{rule.name}</div>
        <div className="truncate text-[11px] text-fleet-text-subtle">
          {rule.pausedReason ?? whenText(rule.trigger)}
        </div>
      </div>
      {rule.pausedReason && <Badge tone="amber">Paused</Badge>}
      <div className="w-20 text-[11px] text-fleet-text-muted">{formatAgo(rule.lastStart)}</div>
      <div className="flex items-center gap-1">
        <button
          aria-label="Edit"
          onClick={onEdit}
          className="rounded p-1 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text"
        >
          <Pencil size={13} />
        </button>
        <button
          aria-label="Delete"
          onClick={() => void callWorkflows('deleteRule', rule.id).catch(showWorkflowError)}
          className="rounded p-1 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-red-300"
        >
          <Trash2 size={13} />
        </button>
        <Button onClick={onRun}>
          <Play size={11} /> Run now
        </Button>
      </div>
    </div>
  );
}

function LimitsForm({ limits }: { limits: WorkflowLimits }): React.JSX.Element {
  const update = (patch: Partial<WorkflowLimits>): void => {
    callWorkflows('setLimits', { ...limits, ...patch }).catch(showWorkflowError);
  };
  return (
    <section className="flex items-end gap-6 rounded-md border border-fleet-border p-3">
      <div className="w-40">
        <Field label="Agents at once">
          <CountInput value={limits.maxAgents} onChange={(maxAgents) => update({ maxAgents })} />
        </Field>
      </div>
      <label className="flex items-center gap-2 pb-1.5 text-xs text-fleet-text-secondary">
        <input
          type="checkbox"
          checked={limits.runOnBattery}
          onChange={(e) => update({ runOnBattery: e.target.checked })}
        />
        Start automatic runs on battery
      </label>
    </section>
  );
}

export function AutomaticView({ projectPath }: { projectPath: string }): React.JSX.Element {
  const allRules = useWorkflowsStore((s) => s.state.rules);
  const limits = useWorkflowsStore((s) => s.state.limits);
  const [editing, setEditing] = useState<WorkflowRule | 'new' | null>(null);
  const { runNow, sheet } = useRunRule();
  const rules = allRules.filter((rule) => rule.projectPath === projectPath);

  if (editing) {
    return (
      <RuleForm
        projectPath={projectPath}
        rule={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <AwayPanel />
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] leading-relaxed text-fleet-text-subtle">
          Automatic runs start only while Fleet is open. These rules are yours. They are not in the
          TOML file, so a repo cannot start agents on your computer.
        </p>
        <Button tone="primary" onClick={() => setEditing('new')}>
          Add automatic run
        </Button>
      </div>
      {rules.length === 0 ? (
        <Empty title="No automatic runs in this project." />
      ) : (
        <div className="rounded-md border border-fleet-border">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onEdit={() => setEditing(rule)}
              onRun={async () => runNow(rule.id)}
            />
          ))}
        </div>
      )}
      <LimitsForm limits={limits} />
      {sheet}
    </div>
  );
}
