import { useState } from 'react';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanUse,
  PreviousPlanVersion,
  SwapChoice
} from '../../../../shared/agency-jobs';
import {
  capText,
  withLocalBranches,
  type PlanInput,
  type PlanStep
} from '../../../../shared/agency-plan';
import { useAgencyStore } from '../../store/agency-store';
import { holdPlan, holdPlanNote } from '../../store/bridge-store';
import { PRIMARY, SECONDARY } from './JobClose';
import { Cautions, ChangeBlock, EnvFiles, NewRoles, StartsFrom, type BaseChoice } from './PlanCard';
import { PlanEditor } from './PlanEditor';
import { PlanNoteForm, type NoteAction, type PointedStep } from './PlanNoteForm';
import { Chip } from './QueueCard';
import { ReaderFrame, ReaderSection } from './ReaderFrame';
import { PlanDiffView, RemovedSteps, StepTags, Was } from './PlanDiffView';
import { formatUsd, plural, runtimeName, stepLabel } from './job-view';
import {
  budgetBefore,
  markEdge,
  removedSteps,
  STATUS_WORD,
  stepCountBefore,
  stepMarks,
  toggled,
  type StepMark
} from './plan-diff';
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
  const { plan, previous } = version;
  const job = detail.job;
  const [swaps, setSwaps] = useState<Record<string, SwapChoice>>({});
  const [bases, setBases] = useState<Record<string, BaseChoice>>({});
  const [editing, setEditing] = useState(false);
  const [noting, setNoting] = useState<NoteAction | null>(null);
  const [pointed, setPointed] = useState<string[]>([]);
  const [showChanges, setShowChanges] = useState(true);
  const [seeBefore, setSeeBefore] = useState(false);
  const before =
    previous === null ? undefined : detail.versions.find((v) => v.version === previous.version);
  const changes = showChanges ? previous : null;

  if (editing) {
    return (
      <ReaderFrame head={head}>
        <PlanEditView version={version} detail={detail} onDone={() => setEditing(false)} />
      </ReaderFrame>
    );
  }
  if (seeBefore && before !== undefined) {
    return (
      <ReaderFrame head={head}>
        <BeforeView before={before} current={version.version} onBack={() => setSeeBefore(false)} />
      </ReaderFrame>
    );
  }

  return (
    <ReaderFrame
      head={head}
      footer={
        <PlanDecision
          version={version}
          noting={noting}
          onNoting={(action) => {
            setNoting(action);
            setPointed([]);
          }}
          pointed={pointed.map((id) => ({ id, label: stepLabel(plan, id) }))}
          onUnpoint={(id) => setPointed(pointed.filter((p) => p !== id))}
          onEdit={() => setEditing(true)}
          onApprove={(acceptCost) =>
            holdPlan(job, version, `Approve plan v${version.version}`, {
              planVersionId: version.id,
              action: 'approve',
              swaps,
              baseChoice: bases,
              acceptCost
            })
          }
          onNote={(action, note) => holdPlanNote(job, version, action, note, pointed)}
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
      {previous !== null && (
        <PlanDiffView
          previous={previous}
          shown={showChanges}
          onShow={setShowChanges}
          onSeeBefore={before === undefined ? undefined : () => setSeeBefore(true)}
        />
      )}
      <PlanGist version={version} changes={changes} />
      <ReaderSection label="Steps">
        <ReaderSteps
          steps={plan.steps}
          marks={changes === null ? undefined : stepMarks(changes.diff, plan, before?.plan)}
          removed={changes === null ? [] : removedSteps(changes.diff, before?.plan)}
          pointed={noting === 'revise' ? pointed : undefined}
          onPoint={(id) => setPointed(toggled(pointed, id))}
        />
      </ReaderSection>
      {version.uses.length > 0 && (
        <ReaderSection label="What it uses from you">
          <UseList uses={version.uses} />
        </ReaderSection>
      )}
      <PlanChecks
        version={version}
        swaps={swaps}
        onSwap={(stepId, choice) => setSwaps({ ...swaps, [stepId]: choice })}
        bases={bases}
        onBase={(member, choice) => setBases({ ...bases, [member]: choice })}
      />
    </ReaderFrame>
  );
}

/** The plan's own editor in the reader, sent as the client's version. */
function PlanEditView({
  version,
  detail,
  onDone
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <PlanEditor
      version={version}
      detail={detail}
      onCancel={onDone}
      onSubmit={async (input) => {
        const result = await useAgencyStore
          .getState()
          .decidePlan(detail.job.id, { planVersionId: version.id, action: 'edit', plan: input });
        if (result.ok) onDone();
        return result;
      }}
    />
  );
}

/** What the plan card asks before approval: swaps, new roles, bases, env files and cautions. */
function PlanChecks({
  version,
  swaps,
  onSwap,
  bases,
  onBase
}: {
  version: AgencyPlanVersion;
  swaps: Record<string, SwapChoice>;
  onSwap: (stepId: string, choice: SwapChoice) => void;
  bases: Record<string, BaseChoice>;
  onBase: (member: string, choice: BaseChoice) => void;
}): React.JSX.Element {
  const { plan, checks } = version;
  const edit = useRefusable(async (input: PlanInput) =>
    useAgencyStore
      .getState()
      .decidePlan(version.jobId, { planVersionId: version.id, action: 'edit', plan: input })
  );
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-fleet-border bg-fleet-surface [&>*:last-child]:border-b-0">
        {version.kind === 'change' && (
          <ChangeBlock version={version} swaps={swaps} onSwap={onSwap} />
        )}
        {plan.newRoles.length > 0 && <NewRoles roles={plan.newRoles} />}
        <StartsFrom bases={checks.bases} choice={bases} onChoose={onBase} />
        <EnvFiles files={checks.envFiles} />
        {(plan.asksFirst.length > 0 || checks.issues.length > 0) && (
          <Cautions version={version} onUseBranch={() => void edit.run(withLocalBranches(plan))} />
        )}
      </div>
      {edit.refused !== null && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400/90">
          {edit.refused}
        </p>
      )}
    </>
  );
}

/** The plan's summary and what it costs, with the old values struck through where they changed. */
function PlanGist({
  version,
  changes
}: {
  version: AgencyPlanVersion;
  /** The changes since the version before, while the client shows them. */
  changes: PreviousPlanVersion | null;
}): React.JSX.Element {
  const { plan } = version;
  const was = changes === null ? {} : budgetBefore(changes.diff);
  const stepsWere = changes === null ? plan.steps.length : stepCountBefore(changes.diff, plan);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm leading-relaxed text-fleet-text">{plan.summary}</p>
      <div className="flex flex-wrap gap-1.5">
        <Chip>
          {was.usd !== undefined && <Was>${formatUsd(was.usd)}</Was>}${formatUsd(plan.budget.usd)}{' '}
          budget
        </Chip>
        {(plan.budget.weekPct !== undefined || typeof was.weekPct === 'number') && (
          <Chip>
            {typeof was.weekPct === 'number' && <Was>{was.weekPct}%</Was>}
            {plan.budget.weekPct === undefined ? 'No' : `${plan.budget.weekPct}%`} Claude week
          </Chip>
        )}
        <Chip>
          {stepsWere !== plan.steps.length && <Was>{stepsWere}</Was>}
          {plural(plan.steps.length, 'crew member')}
        </Chip>
        <Chip>{plan.playbook}</Chip>
        {version.author === 'client' && <Chip>Your edit</Chip>}
      </div>
    </div>
  );
}

/** Every step with all it says: who does it, what it uses and hands back, what it waits on, its cap. */
function ReaderSteps({
  steps,
  marks,
  removed = [],
  pointed,
  onPoint
}: {
  steps: PlanStep[];
  /** What changed in each step since the version before, while shown. */
  marks?: Map<string, StepMark>;
  /** Steps the version before had, shown after the rest. */
  removed?: Array<{ id: string; title: string }>;
  /** The steps a change request points at; present while the client writes one. */
  pointed?: string[];
  onPoint?: (id: string) => void;
}): React.JSX.Element {
  const number = new Map(steps.map((s, i) => [s.id, i + 1]));
  return (
    <div className="flex flex-col gap-1.5">
      <ol className="flex flex-col divide-y divide-fleet-border overflow-hidden rounded-lg border border-fleet-border bg-fleet-surface">
        {steps.map((step, i) => (
          <ReaderStep
            key={step.id}
            step={step}
            n={i + 1}
            waitsOn={step.after.map((id) => `step ${number.get(id) ?? id}`).join(', ')}
            mark={marks?.get(step.id)}
            pointed={pointed?.includes(step.id) ?? false}
            onPoint={pointed === undefined ? undefined : () => onPoint?.(step.id)}
          />
        ))}
      </ol>
      {removed.length > 0 && <RemovedSteps steps={removed} />}
    </div>
  );
}

/** One step in full; while the client writes a change, a click points the change at it. */
function ReaderStep({
  step,
  n,
  waitsOn,
  mark,
  pointed,
  onPoint
}: {
  step: PlanStep;
  n: number;
  waitsOn: string;
  mark: StepMark | undefined;
  pointed: boolean;
  onPoint: (() => void) | undefined;
}): React.JSX.Element {
  const point =
    onPoint === undefined
      ? {}
      : {
          role: 'button',
          tabIndex: 0,
          'aria-pressed': pointed,
          'aria-label': `Point the change at step ${n}: ${step.title}`,
          onClick: onPoint,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            onPoint();
          }
        };
  return (
    <li
      {...point}
      className={`flex gap-3 border-l-2 px-3.5 py-2.5 ${markEdge(mark)}${
        onPoint === undefined
          ? ''
          : ` cursor-pointer transition-colors focus-ring ${
              pointed ? 'bg-blue-500/10' : 'hover:bg-fleet-surface-2/60'
            }`
      }`}
    >
      <span className="w-5 shrink-0 pt-px text-right text-[13px] text-fleet-text-subtle tabular-nums">
        {n}.
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-fleet-text">{step.title}</span>
          <StepTags mark={mark} />
        </div>
        <span className="text-xs text-fleet-text-muted">
          {step.role}
          {step.runtime !== undefined && ` · ${runtimeName(step.runtime)}`}
          {step.model !== undefined && ` · ${step.model}`}
        </span>
        <StepFacts step={step} waitsOn={waitsOn} />
      </div>
    </li>
  );
}

/** What a step uses, hands back, waits on and stops at, where it says. */
function StepFacts({
  step,
  waitsOn
}: {
  step: PlanStep;
  waitsOn: string;
}): React.JSX.Element | null {
  const facts: Array<[string, string]> = [
    ['Uses', step.skills.join(', ')],
    ['Hands back', step.deliverables.map((d) => d.label).join(', ')],
    ['Waits on', waitsOn],
    ['Stops at', step.cap === undefined ? '' : capText(step.cap)]
  ].filter((fact): fact is [string, string] => fact[1] !== '');
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-y-0.5 text-xs">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fleet-text-subtle">{label}</dt>
          <dd className="min-w-0 text-fleet-text-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The version before, to read: what it said and its steps, and the way back. */
function BeforeView({
  before,
  current,
  onBack
}: {
  before: AgencyPlanVersion;
  current: number;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-fleet-border bg-fleet-surface px-3.5 py-2 text-xs">
        <span className="min-w-0 flex-1 text-fleet-text-secondary">
          Plan v{before.version} ({STATUS_WORD[before.status]}), to read only.
        </span>
        <button type="button" onClick={onBack} className={SECONDARY}>
          Back to v{current}
        </button>
      </div>
      <PlanGist version={before} changes={null} />
      <ReaderSection label="Steps">
        <ReaderSteps steps={before.plan.steps} />
      </ReaderSection>
    </>
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
  noting,
  onNoting,
  pointed,
  onUnpoint,
  onEdit,
  onApprove,
  onNote
}: {
  version: AgencyPlanVersion;
  noting: NoteAction | null;
  onNoting: (action: NoteAction | null) => void;
  pointed: PointedStep[];
  onUnpoint: (id: string) => void;
  onEdit: () => void;
  /** `acceptCost`: the client accepted the steps whose cost Fleet cannot measure. */
  onApprove: (acceptCost: boolean) => void;
  onNote: (action: NoteAction, note: string) => void;
}): React.JSX.Element {
  const { plan, checks } = version;
  const [accepted, setAccepted] = useState(false);
  const blocked = checks.issues.some((i) => i.severity === 'block');
  const unmeasured = checks.issues.filter((i) => i.severity === 'accept');

  if (noting !== null) {
    return (
      <PlanNoteForm
        action={noting}
        onCancel={() => onNoting(null)}
        onSend={(note) => onNote(noting, note)}
        {...(noting === 'revise' ? { pointed, onUnpoint } : {})}
      />
    );
  }
  return (
    <>
      {unmeasured.length > 0 && (
        <AcceptCost
          steps={unmeasured.map((i) => i.step).join(', ')}
          accepted={accepted}
          onAccept={setAccepted}
        />
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-fleet-text-muted">
          ${formatUsd(plan.budget.usd)}
          {plan.budget.weekPct !== undefined && ` · ${plan.budget.weekPct}% of week`}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="mr-1 shrink-0 rounded text-xs text-blue-600 transition-colors hover:text-blue-500 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
        >
          Edit the plan
        </button>
        <button type="button" onClick={() => onNoting('reject')} className={SECONDARY}>
          Reject
        </button>
        <button type="button" onClick={() => onNoting('revise')} className={SECONDARY}>
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

/** The client's word that the budget may not count the steps whose cost Fleet cannot measure. */
function AcceptCost({
  steps,
  accepted,
  onAccept
}: {
  steps: string;
  accepted: boolean;
  onAccept: (accepted: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-start gap-2 text-xs text-fleet-text">
      <input
        type="checkbox"
        checked={accepted}
        onChange={(e) => onAccept(e.target.checked)}
        className="fleet-accent-input mt-0.5"
      />
      <span>
        I accept that the budget may not count {steps}. Fleet stops their crew at the cap.
      </span>
    </label>
  );
}
