import { useState } from 'react';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanUse,
  SwapChoice
} from '../../../../shared/agency-jobs';
import { capText, withLocalBranches, type PlanStep } from '../../../../shared/agency-plan';
import { useAgencyStore } from '../../store/agency-store';
import { holdPlan } from '../../store/bridge-store';
import { PRIMARY, SECONDARY } from './JobClose';
import { Cautions, ChangeBlock, EnvFiles, NewRoles, StartsFrom, type BaseChoice } from './PlanCard';
import { PlanNoteForm, type NoteAction } from './PlanNoteForm';
import { Chip } from './QueueCard';
import { ReaderFrame, ReaderSection } from './ReaderFrame';
import { formatUsd, plural, runtimeName } from './job-view';
import { useRefusable } from './use-refusable';

/**
 * A plan waiting on the client, in full in the Bridge's main column: the
 * brief it answers, every step with all it says, the client's lines it
 * follows, everything the plan card asks before approval, and the decision
 * in a footer that stays in view. Decisions are held for undo, like those
 * from the queue card.
 */
export function PlanReader({
  version,
  detail,
  head
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
  head: React.ReactNode;
}): React.JSX.Element {
  const { plan, checks } = version;
  const job = detail.job;
  const [swaps, setSwaps] = useState<Record<string, SwapChoice>>({});
  const [bases, setBases] = useState<Record<string, BaseChoice>>({});
  const edit = useRefusable(async (planVersionId: number) =>
    useAgencyStore
      .getState()
      .decidePlan(job.id, { planVersionId, action: 'edit', plan: withLocalBranches(plan) })
  );

  return (
    <ReaderFrame
      head={head}
      footer={
        <PlanDecision
          version={version}
          onApprove={(acceptCost) =>
            holdPlan(job, version, `Approve plan v${version.version}`, {
              planVersionId: version.id,
              action: 'approve',
              swaps,
              baseChoice: bases,
              acceptCost
            })
          }
          onNote={(action, note) =>
            holdPlan(
              job,
              version,
              action === 'revise'
                ? `Ask for a change to plan v${version.version}`
                : `Reject plan v${version.version}`,
              action === 'revise'
                ? { planVersionId: version.id, action, note, steps: [] }
                : { planVersionId: version.id, action, note }
            )
          }
        />
      }
    >
      {job.brief !== '' && (
        <ReaderSection label="Your brief">
          <blockquote className="border-l-2 border-fleet-border-strong pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-fleet-text-secondary">
            {job.brief}
          </blockquote>
        </ReaderSection>
      )}
      <div className="flex flex-col gap-2.5">
        <p className="text-sm leading-relaxed text-fleet-text">{plan.summary}</p>
        <div className="flex flex-wrap gap-1.5">
          <Chip>${formatUsd(plan.budget.usd)} budget</Chip>
          {plan.budget.weekPct !== undefined && <Chip>{plan.budget.weekPct}% Claude week</Chip>}
          <Chip>{plural(plan.steps.length, 'crew member')}</Chip>
          <Chip>{plan.playbook}</Chip>
          {version.author === 'client' && <Chip>Your edit</Chip>}
        </div>
      </div>
      <ReaderSection label="Steps">
        <ReaderSteps steps={plan.steps} />
      </ReaderSection>
      {version.uses.length > 0 && (
        <ReaderSection label="What it uses from you">
          <UseList uses={version.uses} />
        </ReaderSection>
      )}
      <div className="overflow-hidden rounded-lg border border-fleet-border bg-fleet-surface [&>*:last-child]:border-b-0">
        {version.kind === 'change' && (
          <ChangeBlock
            version={version}
            swaps={swaps}
            onSwap={(stepId, choice) => setSwaps({ ...swaps, [stepId]: choice })}
          />
        )}
        {plan.newRoles.length > 0 && <NewRoles roles={plan.newRoles} />}
        <StartsFrom
          bases={checks.bases}
          choice={bases}
          onChoose={(member, choice) => setBases({ ...bases, [member]: choice })}
        />
        <EnvFiles files={checks.envFiles} />
        {(plan.asksFirst.length > 0 || checks.issues.length > 0) && (
          <Cautions version={version} onUseBranch={() => void edit.run(version.id)} />
        )}
      </div>
      {edit.refused !== null && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400/90">
          {edit.refused}
        </p>
      )}
    </ReaderFrame>
  );
}

/** Every step with all it says: who does it, what it uses and hands back, what it waits on, its cap. */
function ReaderSteps({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  const number = new Map(steps.map((s, i) => [s.id, i + 1]));
  return (
    <ol className="flex flex-col divide-y divide-fleet-border rounded-lg border border-fleet-border bg-fleet-surface">
      {steps.map((step, i) => {
        const facts: Array<[string, string]> = [
          ['Uses', step.skills.join(', ')],
          ['Hands back', step.deliverables.map((d) => d.label).join(', ')],
          ['Waits on', step.after.map((id) => `step ${number.get(id) ?? id}`).join(', ')],
          ['Stops at', step.cap === undefined ? '' : capText(step.cap)]
        ];
        return (
          <li key={step.id} className="flex gap-3 px-3.5 py-2.5">
            <span className="w-5 shrink-0 pt-px text-right text-[13px] text-fleet-text-subtle tabular-nums">
              {i + 1}.
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[13px] font-medium text-fleet-text">{step.title}</span>
              <span className="text-xs text-fleet-text-muted">
                {step.role}
                {step.runtime !== undefined && ` · ${runtimeName(step.runtime)}`}
                {step.model !== undefined && ` · ${step.model}`}
              </span>
              {facts.some(([, value]) => value !== '') && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {facts
                    .filter(([, value]) => value !== '')
                    .map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-fleet-text-subtle">{label}</dt>
                        <dd className="min-w-0 text-fleet-text-secondary">{value}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The client's saved lines the plan follows, each with where it was saved. */
function UseList({ uses }: { uses: PlanUse[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {uses.map((use) => (
        <li key={use.id} className="flex items-baseline gap-2 text-[13px]">
          <span className="min-w-0 flex-1 text-fleet-text-secondary">{use.text}</span>
          <span className="shrink-0 text-[11px] text-fleet-text-subtle">
            {use.layer === 'you' ? 'You · every project' : 'This project'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The reader's footer: Approve, Change and Reject, or the note a change or a rejection needs. */
function PlanDecision({
  version,
  onApprove,
  onNote
}: {
  version: AgencyPlanVersion;
  /** `acceptCost`: the client accepted the steps whose cost Fleet cannot measure. */
  onApprove: (acceptCost: boolean) => void;
  onNote: (action: NoteAction, note: string) => void;
}): React.JSX.Element {
  const { plan, checks } = version;
  const [noting, setNoting] = useState<NoteAction | null>(null);
  const [accepted, setAccepted] = useState(false);
  const blocked = checks.issues.some((i) => i.severity === 'block');
  const unmeasured = checks.issues.filter((i) => i.severity === 'accept');

  if (noting !== null) {
    return (
      <PlanNoteForm
        action={noting}
        onCancel={() => setNoting(null)}
        onSend={(note) => onNote(noting, note)}
      />
    );
  }
  return (
    <>
      {unmeasured.length > 0 && (
        <label className="flex items-start gap-2 text-xs text-fleet-text">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="fleet-accent-input mt-0.5"
          />
          <span>
            I accept that the budget may not count {unmeasured.map((i) => i.step).join(', ')}. Fleet
            stops their crew at the cap.
          </span>
        </label>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fleet-text-muted">
          Budget ${formatUsd(plan.budget.usd)}
          {plan.budget.weekPct !== undefined && ` and ${plan.budget.weekPct}% of week`}
        </span>
        <button type="button" onClick={() => setNoting('reject')} className={SECONDARY}>
          Reject
        </button>
        <button type="button" onClick={() => setNoting('revise')} className={SECONDARY}>
          Change
        </button>
        <button
          type="button"
          disabled={blocked || (unmeasured.length > 0 && !accepted)}
          onClick={() => onApprove(accepted)}
          className={PRIMARY}
        >
          {version.kind === 'change' ? 'Approve change' : 'Approve plan'}
        </button>
      </div>
    </>
  );
}
