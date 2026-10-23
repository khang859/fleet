import { useState } from 'react';
import { Check, CircleAlert, Lock } from 'lucide-react';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanAction,
  PlanUse,
  StepEnvFiles
} from '../../../../shared/agency-jobs';
import { withLocalBranches, type NewRole, type PlanInput } from '../../../../shared/agency-plan';
import { jobDisplayId, TERMINAL_JOB_STATES } from '../../../../shared/agency';
import { useAgencyStore } from '../../store/agency-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { CancelConfirm } from './JobClose';
import { OnboardingButton } from './onboarding-ui';
import { PlanEditor } from './PlanEditor';
import { formatUsd, plural, runtimeName } from './job-view';
import { useRefusable, type RefusableAction } from './use-refusable';

/**
 * A plan version, as its row in the chat. A plan starts on its own once
 * Fleet's checks pass, so the newest version of an open job shows what runs,
 * with Stop and Change something. A version the checks held back also says
 * why, while the Admiral fixes it. Any other version says what became of it,
 * in one line.
 */
export function PlanCard({
  version,
  detail
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  if (!current(version, detail)) return <SettledPlan version={version} detail={detail} />;
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

/** The newest version of an open job, started or held back by a check. */
function current(version: AgencyPlanVersion, detail: AgencyJobDetail): boolean {
  const { state } = detail.job;
  return (
    (version.status === 'approved' || version.status === 'proposed') &&
    detail.versions[detail.versions.length - 1]?.id === version.id &&
    state !== 'closing' &&
    !TERMINAL_JOB_STATES.includes(state)
  );
}

/** The client's saved lines the plan follows, as a block of the card. */
function UsesChips({ uses }: { uses: PlanUse[] }): React.JSX.Element | null {
  if (uses.length === 0) return null;
  return (
    <Block>
      <Label>USING WHAT I KNOW ABOUT YOU</Label>
      <UseChipList uses={uses} />
    </Block>
  );
}

/** The client's saved lines a plan follows, as chips. */
export function UseChipList({ uses }: { uses: PlanUse[] }): React.JSX.Element {
  return (
    <ul aria-label="Using what I know about you" className="flex flex-wrap gap-1.5">
      {uses.map((use) => (
        <li
          key={use.id}
          title={`${use.layer === 'you' ? 'You · every project' : 'This project'}: ${use.text}`}
          className="max-w-full truncate rounded-full bg-fleet-surface-2 px-2.5 py-1 text-xs text-fleet-text-secondary"
        >
          {use.text}
        </li>
      ))}
    </ul>
  );
}

/** The plan in force or held back: what runs, what the checks found, and Stop and Change. */
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
  const [stopping, setStopping] = useState(false);
  const edit = useDecision(detail.job.id);
  const held = version.status === 'proposed';
  return (
    <section
      aria-label={`Plan v${version.version}`}
      className="flex flex-col overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface"
    >
      <PlanSteps version={version} />
      <UsesChips uses={version.uses} />
      {plan.newRoles.length > 0 && <NewRoles roles={plan.newRoles} />}
      {plan.steps.some((s) => s.deliverables.length > 0) && <YouGet version={version} />}
      <EnvFiles files={checks.envFiles} />
      {(plan.asksFirst.length > 0 || checks.issues.length > 0) && (
        <Cautions
          version={version}
          onUseBranch={() =>
            void edit.run({
              planVersionId: version.id,
              action: 'edit',
              plan: withLocalBranches(plan)
            })
          }
        />
      )}
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {held && (
          <p className="text-xs text-fleet-text-muted">
            Fleet&apos;s checks held this plan back. It starts once that is fixed.
          </p>
        )}
        {stopping ? (
          <CancelConfirm job={detail.job} onKeep={() => setStopping(false)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fleet-text-muted">
              Budget ${formatUsd(plan.budget.usd)}
              {plan.budget.weekPct !== undefined && ` and ${plan.budget.weekPct}% of week`} ·{' '}
              {plural(plan.steps.length, 'step')}
            </span>
            <div className="flex-1" />
            <OnboardingButton kind="ghost" onClick={() => setStopping(true)}>
              Stop
            </OnboardingButton>
            <OnboardingButton disabled={edit.busy} onClick={onEdit}>
              Change something
            </OnboardingButton>
          </div>
        )}
        {edit.refused !== null && (
          <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
            {edit.refused}
          </p>
        )}
      </div>
    </section>
  );
}

function PlanSteps({ version }: { version: AgencyPlanVersion }): React.JSX.Element {
  const { plan } = version;
  const change = version.kind === 'change';
  return (
    <Block>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap">
        <Label tone={change ? 'amber' : 'muted'}>
          {change ? `PLAN CHANGE · v${version.version}` : 'PLAN'}
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
                {step.skills.length > 0 && ` · uses ${step.skills.join(', ')}`}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Block>
  );
}

/** The env files each step's crew get a copy of, so the client sees where its secrets go. */
export function EnvFiles({ files }: { files: StepEnvFiles[] }): React.JSX.Element | null {
  if (files.length === 0) return null;
  return (
    <Block>
      <Label>ENV FILES</Label>
      {files.map((f) => (
        <div key={f.stepId} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-fleet-text-secondary">{f.stepId}</span>
          <span className="font-mono text-fleet-text-muted">{f.files.join(' · ')}</span>
        </div>
      ))}
    </Block>
  );
}

/** Roles the plan brings, each with what it says, saved in the project's crew when it starts. */
export function NewRoles({ roles }: { roles: NewRole[] }): React.JSX.Element {
  return (
    <Block>
      <Label>{roles.length === 1 ? 'NEW ROLE' : 'NEW ROLES'}</Label>
      {roles.map((role) => (
        <details key={role.name} className="group text-xs">
          <summary className="flex cursor-pointer list-none flex-col gap-0.5 rounded focus-ring">
            <span className="text-[13px] text-fleet-text">
              {role.name}
              <span className="text-xs text-fleet-text-muted">
                {' '}
                · {runtimeName(role.runtime)}
                {role.model !== undefined && ` · ${role.model}`}
              </span>
            </span>
            <span className="text-fleet-text-secondary">{role.description}</span>
            <span className="text-[11px] text-fleet-text-subtle group-open:hidden">
              Show instructions
            </span>
          </summary>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-fleet-surface-2 px-2 py-1.5 text-fleet-text-secondary">
            {role.instructions}
          </p>
        </details>
      ))}
      <p className="text-[11px] text-fleet-text-subtle">
        Saved in this project&apos;s crew in Fleet when the plan starts. The repository gets no
        file.
      </p>
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

/** What the Admiral asks before doing, and what Fleet's checks found. */
export function Cautions({
  version,
  onUseBranch
}: {
  version: AgencyPlanVersion;
  onUseBranch: () => void;
}): React.JSX.Element {
  const { plan, checks } = version;
  const trust = checks.issues.filter((i) => i.fix === 'trust-claude');
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
      {checks.overlap.length > 0 && (
        <ul aria-label="Paths another job touches" className="flex flex-col gap-0.5 pl-[18px]">
          {checks.overlap.map((o) => (
            <li
              key={`${o.jobId}-${o.member}-${o.path}-${o.step}`}
              className="truncate font-mono text-[11px] text-fleet-text-muted"
            >
              {jobDisplayId(o.jobId)} · {o.member}/{o.path}
              <span className="font-sans text-fleet-text-subtle"> · {o.step}</span>
            </li>
          ))}
        </ul>
      )}
      {checks.issues.some((i) => i.fix === 'use-branch') && (
        <OnboardingButton kind="ghost" className="w-fit" onClick={onUseBranch}>
          Deliver local branches instead
        </OnboardingButton>
      )}
      {trust.map(({ path, member }) =>
        path === undefined ? null : (
          <OnboardingButton
            key={path}
            kind="ghost"
            className="w-fit"
            onClick={() =>
              useWorkspaceStore.getState().openResumeTab(path, 'claude', 'Claude Code')
            }
          >
            {trust.length === 1
              ? 'Open Claude Code there'
              : `Open Claude Code in ${member ?? 'the root'}`}
          </OnboardingButton>
        )
      )}
    </Block>
  );
}

type Decision = RefusableAction<PlanAction>;

/** Send one decision at a time on a card, and keep main's reason when it refuses. */
function useDecision(jobId: number): Decision {
  return useRefusable(async (action: PlanAction) =>
    useAgencyStore.getState().decidePlan(jobId, action)
  );
}

const shortSha = (sha: string | null): string => sha?.slice(0, 7) ?? 'no commit';

/** Where a one-repository job starts, for its started line. */
function baseNote(version: AgencyPlanVersion): string {
  const pins = Object.values(version.bases ?? {});
  return pins.length === 1 ? ` · from ${shortSha(pins[0].sha)}` : '';
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
          text: `${name} started · ${plural(version.plan.steps.length, 'step')}, $${formatUsd(version.plan.budget.usd)}${baseNote(version)}`,
          icon: <Check size={12} className="shrink-0 text-green-500" />
        };
      case 'superseded':
        return { text: `${name} ran, then a later version changed it`, icon: null };
      case 'rejected':
        return {
          text: `You rejected ${name}${version.decisionNote ? `: ${version.decisionNote}` : ''}`,
          icon: null
        };
      case 'replaced':
        return {
          text: version.decisionNote
            ? `You asked for a change to ${name}: ${version.decisionNote}`
            : `${name} was replaced by v${newest.version}`,
          icon: null
        };
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
