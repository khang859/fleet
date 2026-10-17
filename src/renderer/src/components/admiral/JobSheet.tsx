import type { AgencyJob, AgencyQuestion, AgencySnapshot } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';
import { openQuestions } from '../../store/agency-store';
import { QuestionCard, type QuestionAnswer } from './QuestionCard';
import { jobStatus, TONE_DOT } from './job-view';

/** How wide the sheet is beside the conversation. */
export const JOB_SHEET_WIDTH_PX = 380;

/**
 * The right-hand column of an Admiral pane: what the job is, what is waiting
 * on the client, and the settings it runs on.
 *
 * In the lobby, before any job exists, it explains how a job goes instead -
 * the one moment the client has nothing else to read there. The plan, the
 * crew and the spend come with the phases that produce them; until then the
 * sheet says where the plan will appear rather than drawing empty tables.
 */
export function JobSheet({
  snapshot,
  jobId,
  working,
  defaultBudgetUsd,
  onAnswer,
  onOpenSettings,
  className = ''
}: {
  snapshot: AgencySnapshot | undefined;
  /** The job on screen, or null for the lobby. */
  jobId: number | null;
  /** Whether a turn is running on the job on screen. */
  working: boolean;
  defaultBudgetUsd: number;
  onAnswer: (question: AgencyQuestion, answer: QuestionAnswer) => Promise<boolean>;
  onOpenSettings: () => void;
  className?: string;
}): React.JSX.Element {
  const job = jobId === null ? null : (snapshot?.jobs.find((j) => j.id === jobId) ?? null);
  const waiting = openQuestions(snapshot, jobId);
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
          <JobHeading job={job} asking={waiting.length > 0} working={working} />
        ) : (
          <p className="text-[13px] text-fleet-text-muted">
            {firstRun
              ? 'Your job sheet shows up here once I open a job.'
              : 'Pick a job above to see its sheet, or brief a new one here.'}
          </p>
        )}
      </Section>

      {(waiting.length > 0 || job !== null) && (
        <Section
          label={waiting.length > 0 ? `WAITING ON YOU · ${waiting.length}` : 'WAITING ON YOU'}
          tone={waiting.length > 0 ? 'amber' : 'muted'}
        >
          {waiting.length === 0 ? (
            <p className="text-[13px] text-fleet-text-muted">Nothing needs you right now.</p>
          ) : (
            waiting.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                onAnswer={async (answer) => onAnswer(q, answer)}
                onOpenSettings={onOpenSettings}
              />
            ))
          )}
        </Section>
      )}

      {job !== null && (
        <Section label="PLAN" gap="gap-1">
          <p className="text-[13px] text-fleet-text-muted">
            The plan shows up here once the Admiral writes one: the crew, what you get back, and a
            budget. Nothing starts until you approve it.
          </p>
        </Section>
      )}

      {firstRun && <HowAJobGoes />}

      <div className="flex-1" />
      <SettingsBox
        budgetLabel={job !== null ? 'Budget' : 'Default budget'}
        budgetUsd={job?.budgetUsd ?? defaultBudgetUsd}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}

function Section({
  label,
  tone = 'muted',
  gap = 'gap-2',
  children
}: {
  label: string;
  tone?: 'muted' | 'amber';
  gap?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`flex flex-col ${gap}`}>
      <h3
        className={`text-[11px] font-semibold tracking-[0.04em] ${
          tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-fleet-text-muted'
        }`}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

function JobHeading({
  job,
  asking,
  working
}: {
  job: AgencyJob;
  asking: boolean;
  working: boolean;
}): React.JSX.Element {
  const status = jobStatus(job, { asking, working });
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

function formatUsd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
