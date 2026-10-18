import { useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanActionResult
} from '../../../../shared/agency-jobs';
import type { PlanInput, PlanStep } from '../../../../shared/agency-plan';
import { OnboardingButton } from './onboarding-ui';
import { formatUsd } from './job-view';

type Row = { step: PlanStep; removed: boolean; added: boolean; locked: boolean };

/**
 * The client's own version of a plan: the summary, each step's title and
 * role, steps removed or added, and the budget. Steps that are done are
 * locked, and the budget cannot go below what was spent; main checks both
 * again. Sending it makes a new version that waits like any other.
 */
export function PlanEditor({
  version,
  detail,
  onCancel,
  onSubmit
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
  onCancel: () => void;
  onSubmit: (plan: PlanInput) => Promise<PlanActionResult>;
}): React.JSX.Element {
  const done = new Set(detail.steps.filter((s) => s.status === 'done').map((s) => s.id));
  const [summary, setSummary] = useState(version.plan.summary);
  const [budget, setBudget] = useState(String(version.plan.budget.usd));
  const [rows, setRows] = useState<Row[]>(() =>
    version.plan.steps.map((step) => ({
      step,
      removed: false,
      added: false,
      locked: done.has(step.id)
    }))
  );
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const usd = Number(budget);
  const budgetOk = Number.isFinite(usd) && usd > 0 && usd >= detail.spendUsd;
  const kept = rows.filter((r) => !r.removed);
  const valid = budgetOk && summary.trim() !== '' && stepsFilled(kept);

  const edit = (i: number, patch: Partial<PlanStep>): void =>
    setRows(rows.map((r, j) => (j === i ? { ...r, step: { ...r.step, ...patch } } : r)));

  const addStep = (): void => {
    const ids = new Set(rows.map((r) => r.step.id));
    let n = rows.length + 1;
    while (ids.has(`step-${n}`)) n += 1;
    setRows([
      ...rows,
      { step: blankStep(`step-${n}`), removed: false, added: true, locked: false }
    ]);
  };

  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    const ids = new Set(kept.map((r) => r.step.id));
    const plan: PlanInput = {
      ...version.plan,
      summary: summary.trim(),
      budget: { ...version.plan.budget, usd },
      // A step that waited on a removed one now starts without it.
      steps: kept.map((r) => ({ ...r.step, after: r.step.after.filter((id) => ids.has(id)) })),
      // A new role goes with the last step that used it.
      newRoles: version.plan.newRoles.filter((role) => kept.some((r) => r.step.role === role.name))
    };
    setBusy(true);
    setRefused(null);
    const result = await onSubmit(plan).catch(
      (err: unknown): PlanActionResult => ({ ok: false, reason: String(err) })
    );
    setBusy(false);
    if (!result.ok) setRefused(result.reason);
  };

  const changes = rows.filter((r) => r.removed || r.added).length;

  return (
    <section
      aria-label={`Editing plan v${version.version}`}
      className="flex flex-col gap-3 rounded-lg border border-blue-500/60 bg-fleet-surface p-3.5"
    >
      <div className="flex flex-col gap-0.5">
        <h4 className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
          EDITING THE PLAN · FROM v{version.version}
        </h4>
        <p className="text-xs text-fleet-text-subtle">
          Done steps are locked. Nothing changes until you approve your version.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fleet-text-muted">Summary</span>
        <textarea
          value={summary}
          rows={2}
          onChange={(e) => setSummary(e.target.value)}
          className="resize-none rounded-md border border-fleet-border bg-fleet-bg px-2 py-1.5 text-xs text-fleet-text outline-none focus:border-fleet-border-strong"
        />
      </label>

      <ol className="flex flex-col gap-1.5">
        {rows.map((row, i) => (
          <StepRow
            key={row.step.id}
            row={row}
            n={i + 1}
            onEdit={(patch) => edit(i, patch)}
            onToggle={() =>
              row.added
                ? setRows(rows.filter((_, j) => j !== i))
                : setRows(rows.map((r, j) => (j === i ? { ...r, removed: !r.removed } : r)))
            }
          />
        ))}
      </ol>
      <button
        type="button"
        onClick={addStep}
        className="flex w-fit items-center gap-1 text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
      >
        <Plus size={12} />
        Add step
      </button>

      <BudgetField value={budget} onChange={setBudget} spendUsd={detail.spendUsd} ok={budgetOk} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fleet-text-subtle">{changeLabel(changes)}</span>
        <div className="flex-1" />
        <OnboardingButton kind="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </OnboardingButton>
        <OnboardingButton kind="primary" disabled={busy || !valid} onClick={() => void submit()}>
          Send my version
        </OnboardingButton>
      </div>
      {refused !== null && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
          {refused}
        </p>
      )}
    </section>
  );
}

const changeLabel = (n: number): string =>
  n === 0 ? 'Edit any step, or the budget' : `${n} step change${n === 1 ? '' : 's'}`;

/** The plan's budget in dollars; it cannot go below what the job has spent. */
function BudgetField({
  value,
  onChange,
  spendUsd,
  ok
}: {
  value: string;
  onChange: (value: string) => void;
  spendUsd: number;
  ok: boolean;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-fleet-text-muted">Budget $</span>
      <input
        type="number"
        min={Math.max(spendUsd, 0)}
        step="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 rounded border border-fleet-border bg-fleet-bg px-1.5 py-0.5 font-mono text-xs text-fleet-text outline-none focus:border-fleet-border-strong"
      />
      <span className={ok ? 'text-fleet-text-subtle' : 'text-amber-700 dark:text-amber-400'}>
        ${formatUsd(spendUsd)} spent, so it cannot go lower
      </span>
    </label>
  );
}

/** At least one step is kept, and each kept step has a title and a role. */
const stepsFilled = (kept: Row[]): boolean =>
  kept.length > 0 && kept.every((r) => r.step.title.trim() !== '' && r.step.role.trim() !== '');

const blankStep = (id: string): PlanStep => ({
  id,
  role: 'builder',
  title: '',
  after: [],
  changes: [],
  reads: [],
  paths: [],
  deliverables: [],
  workspace: 'new'
});

/** One step in the editor: locked when done, else its title and role, with Remove or Undo. */
function StepRow({
  row,
  n,
  onEdit,
  onToggle
}: {
  row: Row;
  n: number;
  onEdit: (patch: Partial<PlanStep>) => void;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <li
      className={`flex items-center gap-1.5 rounded-md border bg-fleet-bg px-2 py-1.5 ${
        row.added ? 'border-green-500/40' : 'border-fleet-border'
      } ${row.removed ? 'opacity-50' : ''}`}
    >
      <span className="w-4 shrink-0 text-right text-xs text-fleet-text-subtle">{n}</span>
      {row.locked ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fleet-text-muted">
          <Lock size={11} className="shrink-0" />
          <span className="truncate">
            {row.step.title} · {row.step.role}
          </span>
          <span className="ml-auto shrink-0 text-fleet-text-subtle">done</span>
        </span>
      ) : (
        <>
          <input
            value={row.step.title}
            disabled={row.removed}
            placeholder="What the step does"
            aria-label={`Step ${n} title`}
            onChange={(e) => onEdit({ title: e.target.value })}
            className={`min-w-0 flex-1 bg-transparent text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle ${
              row.removed ? 'line-through' : ''
            }`}
          />
          <input
            value={row.step.role}
            disabled={row.removed}
            aria-label={`Step ${n} role`}
            onChange={(e) => onEdit({ role: e.target.value })}
            className="w-24 shrink-0 rounded border border-fleet-border bg-fleet-surface px-1.5 py-0.5 text-xs text-fleet-text-secondary outline-none focus:border-fleet-border-strong"
          />
          <button
            type="button"
            onClick={onToggle}
            aria-label={`${row.removed ? 'Keep' : 'Remove'} step ${n}`}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
          >
            {row.removed ? 'Undo' : 'Remove'}
          </button>
        </>
      )}
    </li>
  );
}
