import { useState } from 'react';
import { Check, CircleAlert, Lock } from 'lucide-react';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanAction,
  PlanActionResult,
  SwapChoice
} from '../../../../shared/agency-jobs';
import { diffLine, type PlanInput } from '../../../../shared/agency-plan';
import { useAgencyStore } from '../../store/agency-store';
import { OnboardingButton } from './onboarding-ui';
import { PillRadio } from '../ui/pill-radio';
import { PlanEditor } from './PlanEditor';
import { formatUsd, runtimeName } from './job-view';

/**
 * A plan version the Admiral proposed, as the card the client decides on:
 * the steps, what each hands back, what the Admiral asks before doing, the
 * budget, and Approve, Change something and Reject.
 *
 * A change to an approved plan also says what changes and what approving it
 * does: the crew it stops, the questions it withdraws, a choice for each
 * running step it swaps, and what was delivered and spent so far. Only the
 * newest waiting version takes a decision; any other one says what became of
 * it, in one line.
 */
export function PlanCard({
  version,
  detail
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  if (version.status !== 'proposed') return <SettledPlan version={version} detail={detail} />;
  if (editing) {
    return (
      <PlanEditor
        version={version}
        detail={detail}
        onCancel={() => setEditing(false)}
        onSubmit={async (plan: PlanInput) => {
          const result = await useAgencyStore
            .getState()
            .decidePlan(detail.job.id, { planVersionId: version.id, action: 'edit', plan });
          if (result.ok) setEditing(false);
          return result;
        }}
      />
    );
  }
  return <OpenPlan version={version} detail={detail} onEdit={() => setEditing(true)} />;
}

function OpenPlan({
  version,
  detail,
  onEdit
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
  onEdit: () => void;
}): React.JSX.Element {
  const { plan, checks } = version;
  const [swaps, setSwaps] = useState<Record<string, SwapChoice>>({});
  return (
    <section
      aria-label={`Plan v${version.version}`}
      className="flex flex-col overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface"
    >
      <PlanSteps version={version} />
      {version.kind === 'change' && (
        <ChangeBlock
          version={version}
          swaps={swaps}
          onSwap={(stepId, choice) => setSwaps({ ...swaps, [stepId]: choice })}
        />
      )}
      {plan.steps.some((s) => s.deliverables.length > 0) && <YouGet version={version} />}
      {(plan.asksFirst.length > 0 || checks.issues.length > 0) && <Cautions version={version} />}
      <DecisionBar version={version} jobId={detail.job.id} swaps={swaps} onEdit={onEdit} />
    </section>
  );
}

function PlanSteps({ version }: { version: AgencyPlanVersion }): React.JSX.Element {
  const { plan } = version;
  const change = version.kind === 'change';
  return (
    <Block>
      <div className="flex items-center gap-2">
        <Label tone={change ? 'amber' : 'muted'}>
          {change ? `PLAN CHANGE · v${version.version} · NEEDS YOUR OK` : 'PLAN'}
        </Label>
        <span className="rounded bg-fleet-surface-2 px-1.5 text-[11px] text-fleet-text-muted">
          {plan.playbook}
        </span>
        {version.author === 'client' && (
          <span className="text-[11px] text-fleet-text-subtle">your edit</span>
        )}
      </div>
      <p className="text-[13px] text-fleet-text-secondary">{plan.summary}</p>
      <ol className="flex flex-col gap-0.5 pt-0.5">
        {plan.steps.map((step, i) => (
          <li key={step.id} className="flex gap-1.5 text-[13px] text-fleet-text">
            <span className="w-4 shrink-0 text-right text-fleet-text-subtle">{i + 1}.</span>
            <span className="min-w-0">
              {step.title}
              <span className="text-xs text-fleet-text-muted">
                {' '}
                · {step.role}
                {step.runtime !== undefined && ` · ${runtimeName(step.runtime)}`}
                {step.model !== undefined && ` · ${step.model}`}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Block>
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a change changes against the approved plan, and what approving it does. */
function ChangeBlock({
  version,
  swaps,
  onSwap
}: {
  version: AgencyPlanVersion;
  swaps: Record<string, SwapChoice>;
  onSwap: (stepId: string, choice: SwapChoice) => void;
}): React.JSX.Element {
  const { effects } = version;
  return (
    <Block>
      <Label>WHAT CHANGES</Label>
      <ul className="flex flex-col gap-0.5 text-xs text-fleet-text-secondary">
        {version.diff.length === 0 ? (
          <li>Nothing changes from v{version.parentVersion}.</li>
        ) : (
          version.diff.map((entry, i) => <li key={i}>{diffLine(entry)}</li>)
        )}
      </ul>
      {effects !== null && (
        <ul className="flex flex-col gap-0.5 text-xs text-fleet-text-muted">
          {effects.stopCrew.length > 0 && (
            <li className="text-amber-700 dark:text-amber-400">
              Stops {effects.stopCrew.map((c) => c.label).join(', ')} when you approve
            </li>
          )}
          {effects.withdrawnQuestions.length > 0 && (
            <li>Withdraws {plural(effects.withdrawnQuestions.length, 'open question')}</li>
          )}
          <li>
            ${formatUsd(effects.spendUsd)} spent so far ·{' '}
            {plural(effects.deliveredResults, 'result')} delivered
          </li>
        </ul>
      )}
      {effects?.swaps.map((swap) => (
        <div key={swap.stepId} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-fleet-text-secondary">
            {swap.stepId}: new {swap.fields.join(' and ')}. Its work so far
          </span>
          <PillRadio
            label={`What ${swap.stepId} does with its work so far`}
            value={swaps[swap.stepId] ?? 'continue'}
            options={SWAP_OPTIONS}
            onChange={(choice) => onSwap(swap.stepId, choice)}
            className="bg-fleet-bg"
          />
        </div>
      ))}
    </Block>
  );
}

function YouGet({ version }: { version: AgencyPlanVersion }): React.JSX.Element {
  return (
    <Block>
      <Label>YOU GET</Label>
      <div className="flex flex-wrap gap-1.5">
        {version.plan.steps.flatMap((step) =>
          step.deliverables.map((d, i) => (
            <span
              key={`${step.id}-${i}`}
              className="rounded bg-fleet-surface-2 px-2 py-0.5 text-xs text-fleet-text"
            >
              {d.label} <span className="text-fleet-text-subtle">· {step.role}</span>
            </span>
          ))
        )}
      </div>
    </Block>
  );
}

/** What the Admiral asks before doing, and what the pre-approval check found. */
function Cautions({ version }: { version: AgencyPlanVersion }): React.JSX.Element {
  const { plan, checks } = version;
  return (
    <Block>
      {plan.asksFirst.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          I ask you first: {plan.asksFirst.join(', ')}.
        </p>
      )}
      {checks.issues.map((issue, i) => (
        <p
          key={i}
          className={`flex gap-1.5 text-xs ${
            issue.severity === 'block'
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          {issue.text}
        </p>
      ))}
    </Block>
  );
}

/** The budget line and Approve, Change something and Reject, with a note for a reject. */
function DecisionBar({
  version,
  jobId,
  swaps,
  onEdit
}: {
  version: AgencyPlanVersion;
  jobId: number;
  swaps: Record<string, SwapChoice>;
  onEdit: () => void;
}): React.JSX.Element {
  const { plan } = version;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const blocked = version.checks.issues.some((i) => i.severity === 'block');

  const decide = async (action: PlanAction): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const result = await useAgencyStore
      .getState()
      .decidePlan(jobId, action)
      .catch((err: unknown): PlanActionResult => ({ ok: false, reason: String(err) }));
    setBusy(false);
    if (!result.ok) setRefused(result.reason);
  };

  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      {rejecting ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = note.trim();
            if (text !== '')
              void decide({ planVersionId: version.id, action: 'reject', note: text });
          }}
        >
          <textarea
            value={note}
            autoFocus
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What should the Admiral do instead?"
            aria-label="Why you reject the plan"
            className="resize-none rounded-md border border-fleet-border bg-fleet-bg px-2 py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle focus:border-fleet-border-strong"
          />
          <div className="flex justify-end gap-2">
            <OnboardingButton kind="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </OnboardingButton>
            <OnboardingButton type="submit" disabled={busy || note.trim() === ''}>
              Reject plan
            </OnboardingButton>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fleet-text-muted">
            Budget ${formatUsd(plan.budget.usd)}
            {plan.budget.weekPct !== undefined && ` and ${plan.budget.weekPct}% of week`} ·{' '}
            {plural(plan.steps.length, 'step')}
          </span>
          <div className="flex-1" />
          <OnboardingButton kind="ghost" disabled={busy} onClick={() => setRejecting(true)}>
            Reject
          </OnboardingButton>
          <OnboardingButton disabled={busy} onClick={onEdit}>
            Change something
          </OnboardingButton>
          <OnboardingButton
            kind="primary"
            disabled={busy || blocked}
            onClick={() => void decide({ planVersionId: version.id, action: 'approve', swaps })}
          >
            {version.kind === 'change' ? 'Approve change' : 'Approve plan'}
          </OnboardingButton>
        </div>
      )}
      {refused !== null && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
          {refused}
        </p>
      )}
    </div>
  );
}

/** A version that is no longer waiting: what became of it, in one line. */
function SettledPlan({
  version,
  detail
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
}): React.JSX.Element {
  const newest = detail.versions[detail.versions.length - 1];
  const name = `${version.kind === 'change' ? 'Plan change' : 'Plan'} v${version.version}`;
  const line = ((): { text: string; icon: React.ReactNode } => {
    switch (version.status) {
      case 'approved':
        return {
          text: `${name} approved · ${version.plan.steps.length} steps, $${formatUsd(version.plan.budget.usd)}`,
          icon: <Check size={12} className="shrink-0 text-green-500" />
        };
      case 'superseded':
        return { text: `${name} was approved, then changed by a later version`, icon: null };
      case 'rejected':
        return {
          text: `You rejected ${name}${version.decisionNote ? `: ${version.decisionNote}` : ''}`,
          icon: null
        };
      case 'replaced':
        return { text: `${name} was replaced by v${newest.version}`, icon: null };
      case 'proposed':
        return { text: name, icon: null };
    }
  })();
  return (
    <div
      aria-label={name}
      className="flex items-center gap-1.5 rounded-lg border border-fleet-border bg-fleet-surface px-3 py-2 text-xs text-fleet-text-muted"
    >
      {line.icon ?? <Lock size={12} className="shrink-0 text-fleet-text-subtle" />}
      <span className="min-w-0 truncate" title={line.text}>
        {line.text}
      </span>
    </div>
  );
}

function Block({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 border-b border-fleet-border px-3.5 py-3">{children}</div>
  );
}

function Label({
  tone = 'muted',
  children
}: {
  tone?: 'muted' | 'amber';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h4
      className={`text-[11px] font-semibold tracking-[0.04em] ${
        tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-fleet-text-muted'
      }`}
    >
      {children}
    </h4>
  );
}

const SWAP_OPTIONS: ReadonlyArray<{ value: SwapChoice; label: string }> = [
  { value: 'continue', label: 'Continue its work' },
  { value: 'restart', label: 'Start over' }
];
