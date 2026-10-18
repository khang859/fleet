import { useEffect } from 'react';
import type { AgencyJob, AgencyQuestion, AgencySnapshot } from '../../../../shared/agency';
import type { SettingsCard } from '../../../../shared/agency-settings';
import { jobDisplayId } from '../../../../shared/agency';
import type {
  AgencyCrewMember,
  AgencyJobDetail,
  AgencyPlanVersion,
  AgencyStep,
  StepStatus
} from '../../../../shared/agency-jobs';
import { focusPane } from '../../lib/focus-pane';
import { openQuestions, planVersions } from '../../store/agency-store';
import { ClientFileNotice } from './ClientFileViews';
import { CancelJob, DeliveredCard, LeftoverList } from './JobClose';
import { PastJobList } from './PastJobs';
import { PlanCard } from './PlanCard';
import { ResultCard } from './ResultCard';
import { SettingsCardView } from './SettingsCard';
import { QuestionCard, type QuestionAnswer } from './QuestionCard';
import { formatUsd, jobStatus, runtimeName, TONE_DOT } from './job-view';

/** How wide the sheet is beside the conversation. */
export const JOB_SHEET_WIDTH_PX = 380;

/**
 * The right-hand column of an Admiral pane: what the job is, what is waiting
 * on the client, and the settings it runs on.
 *
 * In the lobby, before any job exists, it explains how a job goes instead -
 * the one moment the client has nothing else to read there. A plan version
 * waiting on the client is a card under WAITING ON YOU, the same card as in
 * the conversation; the plan the job runs is the PLAN section, step by step.
 */
export function JobSheet({
  snapshot,
  jobId,
  detail,
  working,
  defaultBudgetUsd,
  onAnswer,
  onOpenSettings,
  className = ''
}: {
  snapshot: AgencySnapshot | undefined;
  /** The job on screen, or null for the lobby. */
  jobId: number | null;
  /** That job's plan versions and steps, once loaded. */
  detail: AgencyJobDetail | undefined;
  /** Whether a turn is running on the job on screen. */
  working: boolean;
  defaultBudgetUsd: number;
  onAnswer: (question: AgencyQuestion, answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
  className?: string;
}): React.JSX.Element {
  const job = jobId === null ? null : (snapshot?.jobs.find((j) => j.id === jobId) ?? null);
  const { approved } = planVersions(detail);
  const { pending, waiting, settings, delivered, count } = waitingOnClient(snapshot, job, detail);
  const firstRun = jobId === null && (snapshot?.jobs.length ?? 0) === 0;

  return (
    <aside
      aria-label="Job sheet"
      style={{ width: JOB_SHEET_WIDTH_PX }}
      className={`flex shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-fleet-border bg-fleet-surface ${
        firstRun ? 'p-5' : 'p-4'
      } ${className}`}
    >
      <Section label="THE JOB" gap="gap-1">
        {job !== null ? (
          <JobHeading job={job} detail={detail} asking={count > 0} working={working} />
        ) : (
          <p className="text-[13px] text-fleet-text-muted">
            {firstRun
              ? 'Your job sheet shows up here once I open a job.'
              : 'Pick a job above to see its sheet, or brief a new one here.'}
          </p>
        )}
      </Section>

      {snapshot?.clientFileChanged === true && <ClientFileNotice repoId={snapshot.repoId} />}

      {(count > 0 || job !== null) && (
        <WaitingSection
          count={count}
          delivered={delivered}
          pending={pending}
          detail={detail}
          questions={waiting}
          settings={settings}
          clientFileChanged={snapshot?.clientFileChanged === true}
          onAnswer={onAnswer}
          onOpenSettings={onOpenSettings}
        />
      )}

      {job !== null && <PlanSection detail={detail} />}

      <CrewSection detail={detail} />

      <ResultsSection detail={detail} />

      {job !== null && approved !== null && detail !== undefined && (
        <SpendSection spendUsd={detail.spendUsd} budgetUsd={approved.plan.budget.usd} />
      )}

      {firstRun && <HowAJobGoes />}

      <LeftoversSection snapshot={snapshot} />

      {jobId === null && snapshot !== undefined && snapshot.pastJobs.length > 0 && (
        <Section label="PAST JOBS">
          <PastJobList jobs={snapshot.pastJobs} />
        </Section>
      )}

      <div className="flex-1" />
      <SettingsBox
        budgetLabel={job !== null ? 'Budget' : 'Default budget'}
        budgetUsd={job?.budgetUsd ?? defaultBudgetUsd}
        onOpenSettings={onOpenSettings}
      />
      {job !== null && <CancelJob key={job.id} job={job} />}
    </aside>
  );
}

/** Everything on the job on screen that waits on the client, and how many. */
function waitingOnClient(
  snapshot: AgencySnapshot | undefined,
  job: AgencyJob | null,
  detail: AgencyJobDetail | undefined
): {
  pending: AgencyPlanVersion | null;
  waiting: AgencyQuestion[];
  settings: SettingsCard[];
  delivered: AgencyJob | null;
  count: number;
} {
  const { pending } = planVersions(detail);
  const waiting = openQuestions(snapshot, job?.id ?? null);
  const settings = (snapshot?.settingsCards ?? []).filter(
    (c) => c.jobId === (job?.id ?? null) && c.changes.some((x) => x.status === 'pending')
  );
  const delivered = job?.state === 'delivered' ? job : null;
  const count =
    waiting.length + settings.length + [pending, delivered].filter((x) => x !== null).length;
  return { pending, waiting, settings, delivered, count };
}

/**
 * What the job's steps handed back, newest first. Showing it asks GitHub
 * again about its PRs, so a card says when one changed after delivery.
 */
function ResultsSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  const jobId = detail?.job.id ?? null;
  const prs = detail?.results.filter((r) => r.kind === 'pr').length ?? 0;
  useEffect(() => {
    if (jobId !== null && prs > 0) void window.fleet.agency.refreshResults(jobId);
  }, [jobId, prs]);
  if (detail === undefined || detail.results.length === 0) return null;
  return (
    <Section label={`RESULTS · ${detail.results.length}`}>
      {[...detail.results].reverse().map((result) => (
        <ResultCard key={result.id} result={result} />
      ))}
    </Section>
  );
}

/** What closed jobs' cleanup left in the repository, shown in every view of it. */
function LeftoversSection({
  snapshot
}: {
  snapshot: AgencySnapshot | undefined;
}): React.JSX.Element | null {
  if (snapshot === undefined || snapshot.leftovers.length === 0) return null;
  return (
    <Section label={`LEFTOVERS · ${snapshot.leftovers.length}`}>
      <LeftoverList repoId={snapshot.repoId} leftovers={snapshot.leftovers} />
    </Section>
  );
}

/** Open questions, settings changes and a plan version waiting on the client, as cards. */
function WaitingSection({
  count,
  delivered,
  pending,
  detail,
  questions,
  settings,
  clientFileChanged,
  onAnswer,
  onOpenSettings
}: {
  count: number;
  /** The job on screen, when it waits on the client to accept it. */
  delivered: AgencyJob | null;
  pending: AgencyPlanVersion | null;
  detail: AgencyJobDetail | undefined;
  questions: AgencyQuestion[];
  settings: SettingsCard[];
  clientFileChanged: boolean;
  onAnswer: (question: AgencyQuestion, answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <Section
      label={count > 0 ? `WAITING ON YOU · ${count}` : 'WAITING ON YOU'}
      tone={count > 0 ? 'amber' : 'muted'}
    >
      {count === 0 && (
        <p className="text-[13px] text-fleet-text-muted">Nothing needs you right now.</p>
      )}
      {delivered !== null && <DeliveredCard job={delivered} detail={detail} />}
      {pending !== null && detail !== undefined && <PlanCard version={pending} detail={detail} />}
      {questions.map((q) => (
        <QuestionCard
          key={q.id}
          question={q}
          onAnswer={async (answer) => onAnswer(q, answer)}
          onOpenSettings={onOpenSettings}
          clientFileChanged={clientFileChanged}
        />
      ))}
      {settings.map((card) => (
        <SettingsCardView key={`s${card.id}`} card={card} />
      ))}
    </Section>
  );
}

function PlanSection({ detail }: { detail: AgencyJobDetail | undefined }): React.JSX.Element {
  const { pending, approved } = planVersions(detail);
  return (
    <Section
      label="PLAN"
      gap="gap-1"
      aside={approved === null ? undefined : `v${approved.version} approved`}
    >
      {approved === null || detail === undefined ? (
        <p className="text-[13px] text-fleet-text-muted">
          {pending === null
            ? 'The plan shows up here once the Admiral writes one: the crew, what you get back, and a budget. Nothing starts until you approve it.'
            : 'Nothing starts until you approve the plan above.'}
        </p>
      ) : (
        <PlanSteps detail={detail} />
      )}
    </Section>
  );
}

const CREW_DOT: Record<AgencyCrewMember['status'], string> = {
  starting: 'bg-amber-400',
  live: 'bg-green-400',
  ended: 'bg-fleet-text-subtle'
};

const CREW_STATUS: Record<AgencyCrewMember['status'], string> = {
  starting: 'starting',
  live: 'working',
  ended: 'ended'
};

/**
 * The job's crew members, working ones first, each with its step, runtime
 * and status. Peek brings a working member's pane in front of the client.
 */
function CrewSection({
  detail
}: {
  detail: AgencyJobDetail | undefined;
}): React.JSX.Element | null {
  if (detail === undefined || detail.crew.length === 0) return null;
  const working = detail.crew.filter((c) => c.status !== 'ended');
  const ended = detail.crew.filter((c) => c.status === 'ended').reverse();
  return (
    <Section label="CREW" gap="gap-1" aside={`${working.length} working`}>
      <ul className="flex flex-col">
        {[...working, ...ended].map((member) => (
          <CrewRow key={member.id} member={member} />
        ))}
      </ul>
    </Section>
  );
}

function CrewRow({ member }: { member: AgencyCrewMember }): React.JSX.Element {
  const { paneId } = member;
  const ended = member.status === 'ended';
  return (
    <li className="flex items-center gap-2 border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0">
      <span className={`size-1.5 shrink-0 rounded-full ${CREW_DOT[member.status]}`} />
      <span
        className={`min-w-0 flex-1 truncate ${ended ? 'text-fleet-text-muted' : 'text-fleet-text'}`}
      >
        {member.label}
        <span className="text-fleet-text-subtle">
          {' '}
          · {member.stepId} · {runtimeName(member.runtime)}
          {member.model !== null && ` ${member.model}`}
        </span>
      </span>
      <span
        className="shrink-0 text-[11px] text-fleet-text-muted"
        title={member.endReason ?? undefined}
      >
        {CREW_STATUS[member.status]}
      </span>
      {!ended && paneId !== null && (
        <button
          type="button"
          onClick={() => void focusPane(paneId)}
          className="shrink-0 rounded text-[11px] font-medium text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
        >
          Peek
        </button>
      )}
    </li>
  );
}

function SpendSection({
  spendUsd,
  budgetUsd
}: {
  spendUsd: number;
  budgetUsd: number;
}): React.JSX.Element {
  return (
    <Section label="SPEND" aside={`$${formatUsd(spendUsd)} of $${formatUsd(budgetUsd)}`}>
      <div className="h-1.5 overflow-hidden rounded-full bg-fleet-surface-2">
        <div
          className="h-full bg-blue-400"
          style={{ width: `${Math.min(100, (spendUsd / budgetUsd) * 100)}%` }}
        />
      </div>
    </Section>
  );
}

function Section({
  label,
  tone = 'muted',
  gap = 'gap-2',
  aside,
  children
}: {
  label: string;
  tone?: 'muted' | 'amber';
  gap?: string;
  /** A short fact on the right of the heading. */
  aside?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`flex flex-col ${gap}`}>
      <div className="flex items-baseline gap-2">
        <h3
          className={`flex-1 text-[11px] font-semibold tracking-[0.04em] ${
            tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-fleet-text-muted'
          }`}
        >
          {label}
        </h3>
        {aside !== undefined && (
          <span className="font-mono text-[11px] text-fleet-text-muted">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

const STEP_TONE: Record<StepStatus, string> = {
  pending: 'text-fleet-text-subtle',
  queued: 'text-fleet-text-muted',
  running: 'text-green-600 dark:text-green-400',
  blocked: 'text-amber-700 dark:text-amber-400',
  interrupted: 'text-amber-700 dark:text-amber-400',
  stopped: 'text-amber-700 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  done: 'text-fleet-text-muted',
  removed: 'text-fleet-text-subtle'
};

const STEP_LABEL: Record<StepStatus, string> = {
  pending: 'not started',
  queued: 'queued',
  running: 'running',
  blocked: 'blocked',
  interrupted: 'interrupted',
  stopped: 'stopped',
  failed: 'failed',
  done: 'done',
  removed: 'removed'
};

/** The approved plan's steps in order, each with its status and last note. */
function PlanSteps({ detail }: { detail: AgencyJobDetail }): React.JSX.Element {
  const approved = planVersions(detail).approved;
  const byId = new Map(approved?.plan.steps.map((s) => [s.id, s]));
  return (
    <ol className="flex flex-col">
      {detail.steps.map((step: AgencyStep, i) => {
        const planned = byId.get(step.id);
        const removed = step.status === 'removed';
        return (
          <li
            key={step.id}
            className="flex flex-col gap-0.5 border-b border-fleet-border/60 py-1.5 last:border-b-0"
          >
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-3 shrink-0 text-right text-fleet-text-subtle">
                {removed ? '' : i + 1}
              </span>
              <span
                className={`min-w-0 flex-1 truncate ${removed ? 'text-fleet-text-subtle line-through' : 'text-fleet-text'}`}
                title={planned?.title}
              >
                {planned?.title ?? step.id}
                <span className="text-fleet-text-subtle">
                  {' '}
                  · {step.role}
                  {planned?.runtime !== undefined && ` · ${runtimeName(planned.runtime)}`}
                </span>
              </span>
              <span className={`shrink-0 text-[11px] ${STEP_TONE[step.status]}`}>
                {STEP_LABEL[step.status]}
              </span>
            </div>
            {step.note !== '' && !removed && (
              <p className="line-clamp-2 pl-5 text-[11px] text-fleet-text-muted" title={step.note}>
                {step.note}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function JobHeading({
  job,
  detail,
  asking,
  working
}: {
  job: AgencyJob;
  detail: AgencyJobDetail | undefined;
  asking: boolean;
  working: boolean;
}): React.JSX.Element {
  const status = jobStatus(job, { asking, working });
  const live = (detail?.steps ?? []).filter((s) => s.status !== 'removed');
  const done = live.filter((s) => s.status === 'done').length;
  const progress =
    job.approvedVersion === null || live.length === 0
      ? ''
      : ` · ${done} of ${live.length} steps done`;
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[15px] font-semibold text-fleet-text">
          {job.title}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {jobDisplayId(job.id)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-fleet-text-muted">
        <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`} />
        {status.label}
        {progress}
      </div>
      {job.brief !== '' && (
        <p
          className="line-clamp-3 pt-1 text-xs leading-relaxed text-fleet-text-muted"
          title={job.brief}
        >
          {job.brief}
        </p>
      )}
    </>
  );
}

const STEPS = [
  'You brief me.',
  'I send a plan: the crew, what you get back, and a budget.',
  'You approve. Crew start in their own tab, and you can peek any time.',
  'Questions show up under WAITING ON YOU. Results come back as cards.'
];

/** The four steps of a job, for a client who has not run one yet. */
export function HowAJobGoes(): React.JSX.Element {
  return (
    <Section label="HOW A JOB GOES" gap="gap-2.5">
      <ol className="flex flex-col gap-2.5">
        {STEPS.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] text-fleet-text-secondary">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-fleet-surface-2 text-[11px] text-fleet-text">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function SettingsBox({
  budgetLabel,
  budgetUsd,
  onOpenSettings
}: {
  budgetLabel: string;
  budgetUsd: number | null;
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-fleet-border bg-fleet-bg p-2.5 text-xs">
      <div className="flex justify-between gap-2">
        <span className="text-fleet-text-muted">{budgetLabel}</span>
        <span className="font-mono text-fleet-text">
          {budgetUsd === null ? 'none set' : `$${formatUsd(budgetUsd)}`}
        </span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-fleet-text-muted">Crew</span>
        <span className="text-fleet-text">Claude Code</span>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className="w-fit pt-1 text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
      >
        Admiral settings
      </button>
    </div>
  );
}
