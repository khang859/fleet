import { useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import type { AgencyJob, AgencySnapshot } from '../../../../shared/agency';
import { jobDisplayId, questionDisplayId } from '../../../../shared/agency';
import type {
  AgencyJobDetail,
  AgencyPlanVersion,
  PlanAction
} from '../../../../shared/agency-jobs';
import { useBridgeStore, type RefusedDecision } from '../../store/bridge-store';
import { relativeTime } from '../agent/settings/format';
import { NeedsYouCard } from './JobSheet';
import { DeliveredCard, PRIMARY, SECONDARY } from './JobClose';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { SettingsCardView } from './SettingsCard';
import { formatUsd, needsChoices, plural } from './job-view';
import type { WaitingItem } from './waiting-queue';

/** How many of a plan's steps its queue card lists before "+ N more". */
const PLAN_STEPS_SHOWN = 3;

/**
 * One item in the Bridge queue: the card the job sheet shows for it, headed
 * by its kind and job, with its main actions on the card. A plan gets a short
 * card of its own; its full card is on the job's tab. Plan and question
 * decisions are held for undo, so the card leaves the queue at once.
 */
export function QueueCard({
  item,
  job,
  snapshot,
  refusal,
  onOpenJob,
  onOpenSettings
}: {
  item: WaitingItem;
  /** The open job the item belongs to; null for the lobby. */
  job: AgencyJob | null;
  snapshot: AgencySnapshot;
  /** Why main refused the client's last decision on this item. */
  refusal: RefusedDecision | null;
  onOpenJob: (jobId: number) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const head = (kind: string, at: number | null = item.since): React.JSX.Element => (
    <>
      <QueueHead kind={kind} job={job} at={at} />
      {refusal !== null && <RefusalLine repoId={snapshot.repoId} refusal={refusal} />}
    </>
  );
  switch (item.kind) {
    case 'permission':
      // The card counts down to its expiry in its own title row.
      return (
        <PermissionCard
          permission={item.permission}
          paneId={item.detail.crew.find((c) => c.id === item.permission.crewId)?.paneId ?? null}
          head={head('PERMISSION', null)}
        />
      );
    case 'plan':
      return (
        <PlanQueueCard
          version={item.version}
          detail={item.detail}
          head={head(
            `${item.version.kind === 'change' ? 'PLAN CHANGE' : 'PLAN'} v${item.version.version}`
          )}
          onOpenJob={onOpenJob}
        />
      );
    case 'question': {
      const { question } = item;
      return (
        <QuestionCard
          question={question}
          head={head('QUESTION')}
          clientFileChanged={snapshot.clientFileChanged}
          onOpenSettings={onOpenSettings}
          // The answer is held for undo and the card leaves the queue now, so it
          // counts as taken without waiting on the hold.
          // eslint-disable-next-line @typescript-eslint/promise-function-async
          onAnswer={(answer) => {
            void useBridgeStore.getState().hold(
              snapshot.repoId,
              {
                key: item.key,
                jobId: item.jobId,
                label: `Answer ${questionDisplayId(question.id)}`
              },
              { kind: 'answer', answer: { id: question.id, ...answer } }
            );
            return Promise.resolve(true);
          }}
        />
      );
    }
    case 'settings':
      return <SettingsCardView card={item.card} head={head('SETTINGS')} />;
    case 'delivered':
      return <DeliveredCard job={item.job} detail={item.detail} head={head('DELIVERED')} />;
    case 'crew':
      return <NeedsYouCard member={item.member} head={head('NEEDS YOU')} />;
    case 'loading':
      return <LoadingRow what={item.what} job={item.job} />;
  }
}

const LOADING_KIND: Record<Extract<WaitingItem, { kind: 'loading' }>['what'], string> = {
  plan: 'PLAN',
  permission: 'PERMISSION',
  crew: 'NEEDS YOU'
};

/** A plan, permission or crew member the snapshot says waits, while its job's detail loads. */
function LoadingRow({
  what,
  job
}: {
  what: Extract<WaitingItem, { kind: 'loading' }>['what'];
  job: AgencyJob;
}): React.JSX.Element {
  return (
    <div
      aria-busy
      className="rounded-md border border-amber-400/35 bg-fleet-bg px-2.5 py-2 text-xs text-fleet-text-subtle"
    >
      <QueueHead kind={LOADING_KIND[what]} job={job} at={null} />
    </div>
  );
}

/** A queue card's first row: its kind, its job, and how long it has waited. */
function QueueHead({
  kind,
  job,
  at
}: {
  kind: string;
  job: AgencyJob | null;
  at: number | null;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
        {kind}
      </span>
      {job !== null && (
        <>
          <span className="shrink-0 rounded bg-fleet-surface-2 px-1.5 font-mono text-[11px] text-fleet-text-secondary">
            {jobDisplayId(job.id)}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-fleet-text-muted"
            title={job.title}
          >
            {job.title}
          </span>
        </>
      )}
      {at !== null && (
        <span className="ml-auto shrink-0 text-[11px] text-fleet-text-subtle">
          {relativeTime(at)}
        </span>
      )}
    </div>
  );
}

/** Why main would not carry out the client's last decision on the item, until dismissed. */
export function RefusalLine({
  repoId,
  refusal
}: {
  repoId: string;
  refusal: RefusedDecision;
}): React.JSX.Element {
  return (
    <p
      role="status"
      className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400/90"
    >
      <CircleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {refusal.label} did not go through: {refusal.reason}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => useBridgeStore.getState().dismiss(repoId, refusal.key)}
        className="flex size-4 shrink-0 items-center justify-center rounded text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
      >
        <X size={11} />
      </button>
    </p>
  );
}

type NoteAction = 'revise' | 'reject';

const NOTE_FORM: Record<NoteAction, { placeholder: string; label: string; send: string }> = {
  revise: {
    placeholder: 'What should change?',
    label: 'What should change in the plan',
    send: 'Ask for the change'
  },
  reject: {
    placeholder: 'What should the Admiral do instead?',
    label: 'Why you reject the plan',
    send: 'Reject plan'
  }
};

/**
 * A plan waiting on the client, short: its summary, its first steps, what it
 * costs, and Approve, Change and Reject. A plan that takes a choice only its
 * full card asks for, or that a check holds, is approved from the job's tab.
 */
function PlanQueueCard({
  version,
  detail,
  head,
  onOpenJob
}: {
  version: AgencyPlanVersion;
  detail: AgencyJobDetail;
  head: React.ReactNode;
  onOpenJob: (jobId: number) => void;
}): React.JSX.Element {
  const job = detail.job;
  const [noting, setNoting] = useState<NoteAction | null>(null);
  const blocked = version.checks.issues.find((i) => i.severity === 'block');
  const choices = needsChoices(version);
  const name = `plan v${version.version}`;
  const hold = (label: string, action: Exclude<PlanAction, { action: 'edit' }>): void =>
    void useBridgeStore
      .getState()
      .hold(
        job.repoId,
        { key: `plan:${version.id}`, jobId: job.id, label },
        { kind: 'plan', action }
      );

  return (
    <section
      aria-label={`Plan v${version.version} for ${jobDisplayId(job.id)}`}
      className="flex flex-col gap-1.5 rounded-md border border-amber-400/35 bg-fleet-bg p-2.5"
    >
      {head}
      <PlanGist version={version} />
      {blocked !== undefined ? (
        <p className="flex gap-1.5 text-xs text-red-600 dark:text-red-400">
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          {blocked.text}
        </p>
      ) : (
        choices && (
          <p className="text-xs text-fleet-text-muted">
            It has choices to make before you approve it. Open {jobDisplayId(job.id)} to see them.
          </p>
        )
      )}
      {noting === null ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={blocked !== undefined || choices}
            onClick={() =>
              hold(`Approve ${name}`, { planVersionId: version.id, action: 'approve' })
            }
            className={PRIMARY}
          >
            {version.kind === 'change' ? 'Approve change' : 'Approve plan'}
          </button>
          <button type="button" onClick={() => setNoting('revise')} className={SECONDARY}>
            Change
          </button>
          <button type="button" onClick={() => setNoting('reject')} className={SECONDARY}>
            Reject
          </button>
          <button
            type="button"
            onClick={() => onOpenJob(job.id)}
            className="ml-auto rounded text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
          >
            Open {jobDisplayId(job.id)}
          </button>
        </div>
      ) : (
        <PlanNoteForm
          action={noting}
          onCancel={() => setNoting(null)}
          onSend={(note) =>
            hold(
              noting === 'revise' ? `Ask for a change to ${name}` : `Reject ${name}`,
              noting === 'revise'
                ? { planVersionId: version.id, action: 'revise', note, steps: [] }
                : { planVersionId: version.id, action: 'reject', note }
            )
          }
        />
      )}
    </section>
  );
}

/** A plan at a glance: its summary, its first steps, and what it costs. */
function PlanGist({ version }: { version: AgencyPlanVersion }): React.JSX.Element {
  const { plan } = version;
  const more = plan.steps.length - PLAN_STEPS_SHOWN;
  return (
    <>
      <p className="line-clamp-2 text-[13px] font-medium text-fleet-text" title={plan.summary}>
        {plan.summary}
      </p>
      <ol className="flex flex-col gap-0.5 text-xs text-fleet-text-secondary">
        {plan.steps.slice(0, PLAN_STEPS_SHOWN).map((step, i) => (
          <li key={step.id} className="flex min-w-0 gap-1.5">
            <span className="w-3 shrink-0 text-right text-fleet-text-subtle">{i + 1}.</span>
            <span className="min-w-0 truncate" title={step.title}>
              {step.title}
              <span className="text-fleet-text-subtle"> · {step.role}</span>
            </span>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <span className="pl-[18px] text-[11px] text-fleet-text-subtle">
          + {plural(more, 'more step')}
        </span>
      )}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <Chip>${formatUsd(plan.budget.usd)} budget</Chip>
        {plan.budget.weekPct !== undefined && <Chip>{plan.budget.weekPct}% Claude week</Chip>}
        <Chip>{plural(plan.steps.length, 'crew member')}</Chip>
        {version.uses.length > 0 && <Chip>Uses {version.uses.length} of your lines</Chip>}
      </div>
    </>
  );
}

/** The note a change or a rejection needs, in place of the card's buttons. */
function PlanNoteForm({
  action,
  onCancel,
  onSend
}: {
  action: NoteAction;
  onCancel: () => void;
  onSend: (note: string) => void;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  return (
    <form
      className="flex flex-col gap-1.5 pt-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        const text = note.trim();
        if (text !== '') onSend(text);
      }}
    >
      <textarea
        value={note}
        autoFocus
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        placeholder={NOTE_FORM[action].placeholder}
        aria-label={NOTE_FORM[action].label}
        className="resize-none rounded-md border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs text-fleet-text outline-none placeholder:text-fleet-text-subtle focus:border-fleet-border-strong"
      />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" disabled={note.trim() === ''} className={PRIMARY}>
          {NOTE_FORM[action].send}
        </button>
      </div>
    </form>
  );
}

function Chip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded bg-fleet-surface-2 px-1.5 py-0.5 text-[11px] text-fleet-text-secondary">
      {children}
    </span>
  );
}
