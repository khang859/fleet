import { CircleAlert, Maximize2, X } from 'lucide-react';
import type { AgencyJob, AgencySnapshot } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';
import { holdAnswer, useBridgeStore, type RefusedDecision } from '../../store/bridge-store';
import { relativeTime } from '../agent/settings/format';
import { NeedsYouCard } from './JobSheet';
import { DeliveredCard } from './JobClose';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { crewPaneId } from './job-view';
import { kindLabel, type WaitingItem } from './waiting-queue';

/**
 * One item in the Bridge queue: the card the job sheet shows for it, headed
 * by its kind and job, with its main actions on the card and Read for the
 * item in full in the main column. Question answers are held for undo, so
 * the card leaves the queue at once.
 */
export function QueueCard({
  item,
  job,
  snapshot,
  refusal,
  reading,
  onRead,
  onOpenSettings
}: {
  item: WaitingItem;
  /** The open job the item belongs to; null for the lobby. */
  job: AgencyJob | null;
  snapshot: AgencySnapshot;
  /** Why main refused the client's last decision on this item. */
  refusal: RefusedDecision | null;
  /** The reader shows this item. */
  reading: boolean;
  onRead: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  // A permission counts down to its expiry in its own title row.
  const at = item.kind === 'permission' ? null : item.since;
  const head = (
    <>
      <QueueHead
        kind={kindLabel(item)}
        job={job}
        at={at}
        action={<ReadAction reading={reading} onRead={onRead} />}
      />
      {refusal !== null && <RefusalLine repoId={snapshot.repoId} refusal={refusal} />}
    </>
  );
  switch (item.kind) {
    case 'permission':
      return (
        <PermissionCard
          permission={item.permission}
          paneId={crewPaneId(item.detail, item.permission.crewId)}
          head={head}
        />
      );
    case 'question':
      return (
        <QuestionCard
          question={item.question}
          head={head}
          onOpenSettings={onOpenSettings}
          onAnswer={holdAnswer(snapshot.repoId, item.question)}
        />
      );
    case 'delivered':
      return <DeliveredCard job={item.job} detail={item.detail} head={head} />;
    case 'crew':
      return <NeedsYouCard member={item.member} head={head} />;
    case 'loading':
      return (
        <div
          aria-busy
          className="rounded-md border border-amber-400/35 bg-fleet-bg px-2.5 py-2 text-xs text-fleet-text-subtle"
        >
          <QueueHead kind={kindLabel(item)} job={item.job} at={null} />
        </div>
      );
  }
}

/** Read for an item in full, or the mark that the reader shows it. */
function ReadAction({
  reading,
  onRead
}: {
  reading: boolean;
  onRead: () => void;
}): React.JSX.Element {
  if (reading) {
    return (
      <span className="rounded bg-blue-500/15 px-1.5 text-[10px] leading-4 font-semibold tracking-[0.04em] text-blue-600 dark:text-blue-300">
        READING
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onRead}
      aria-label="Read in full"
      title="Read in full"
      className="flex size-5 items-center justify-center rounded text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
    >
      <Maximize2 size={11} />
    </button>
  );
}

/** A queue card's first row: its kind, its job, how long it has waited, and an action. */
export function QueueHead({
  kind,
  job,
  at,
  action
}: {
  kind: string;
  job: AgencyJob | null;
  at: number | null;
  action?: React.ReactNode;
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
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {at !== null && (
          <span className="text-[11px] text-fleet-text-subtle">{relativeTime(at)}</span>
        )}
        {action}
      </span>
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
