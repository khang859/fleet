import { useState } from 'react';
import type { AgencyJob, AgencyLeftover } from '../../../../shared/agency';
import type { AgencyJobDetail, PrState } from '../../../../shared/agency-jobs';
import { waitingFor } from '../../../../shared/pr-review';
import { jobDisplayId } from '../../../../shared/agency';
import { useAgencyStore } from '../../store/agency-store';
import { useRefusable, type RefusableAction } from './use-refusable';

export const PRIMARY =
  'h-7 rounded-md border border-blue-400/60 bg-fleet-surface-2 px-2.5 text-xs font-medium text-fleet-text transition-colors hover:bg-fleet-surface-3 focus-ring disabled:opacity-50';
export const SECONDARY =
  'h-7 rounded-md border border-fleet-border-strong px-2.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring disabled:opacity-50';

/** Closing a job from the sheet: busy while main works, and why it refused. */
function useClose(job: AgencyJob): RefusableAction<'cancel' | 'accept'> {
  return useRefusable(async (action: 'cancel' | 'accept') =>
    useAgencyStore.getState().closeJob(job.repoId, { jobId: job.id, action })
  );
}

function Refused({ reason }: { reason: string | null }): React.JSX.Element | null {
  if (reason === null) return null;
  return (
    <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
      {reason}
    </p>
  );
}

/** The job's PRs still open, one per PR however often it was delivered: the newest card's. */
function openPrs(detail: AgencyJobDetail | undefined): PrState[] {
  const prs = new Map<string, PrState>();
  for (const r of detail?.results ?? [])
    if (r.body.kind === 'pr') prs.set(r.body.pr.url, r.body.pr);
  return [...prs.values()].filter((pr) => pr.state === 'open');
}

/** Why Merge cannot start yet: the first open PR still waiting on a check or a review bot. */
function mergeWait(prs: PrState[]): string | null {
  for (const pr of prs) {
    const waiting = waitingFor(pr.review);
    if (waiting !== '') return `Merge waits for ${waiting} on PR #${pr.number}.`;
  }
  return null;
}

const mergeLabel = (prs: number, again: boolean): string =>
  `${again ? 'Merge again' : 'Merge'}${prs > 1 ? ` ${prs} PRs` : ''}`;

/** Where the merge stands, and why it stopped. */
function MergeNote({ merge }: { merge: AgencyJobDetail['merge'] }): React.JSX.Element | null {
  if (merge === null || merge.note === '') return null;
  return (
    <p
      role="status"
      className={`text-[11px] ${
        merge.status === 'failed'
          ? 'text-amber-700 dark:text-amber-400/90'
          : 'text-fleet-text-secondary'
      }`}
    >
      {merge.status === 'running' ? 'Merging. ' : ''}
      {merge.note}
    </p>
  );
}

/**
 * A delivered job waits on the client: merge its PRs, one at a time in member
 * order, or accept it, which closes it. The Bridge queue names the job in `head`.
 */
export function DeliveredCard({
  job,
  detail,
  head
}: {
  job: AgencyJob;
  detail: AgencyJobDetail | undefined;
  head?: React.ReactNode;
}): React.JSX.Element {
  const { busy, refused, run: close } = useClose(job);
  const merging = useRefusable(async () => useAgencyStore.getState().mergePrs(job.repoId, job.id));
  const merge = detail?.merge ?? null;
  const open = openPrs(detail);
  const prs = open.length;
  const running = merge?.status === 'running';
  const failed = merge?.status === 'failed';
  // A stop after the last PR merged, as a failed umbrella bump, still needs Merge again.
  const canMerge = (prs > 0 || failed) && !running;
  const wait = canMerge ? mergeWait(open) : null;
  return (
    <section
      aria-label={`${jobDisplayId(job.id)} is delivered`}
      className="flex flex-col gap-1.5 rounded-md border border-amber-400/35 bg-fleet-bg p-2.5"
    >
      {head}
      <span className="text-[13px] font-medium text-fleet-text">Everything in the plan is in</span>
      <p className="text-xs leading-relaxed text-fleet-text-muted">
        {prs > 1
          ? 'Merge runs the PRs one at a time in member order, each after its checks pass. '
          : ''}
        Accept to close the job. Crew stop, and worktrees with nothing left in them go. Ask the
        Admiral in the chat for anything more.
      </p>
      <MergeNote merge={merge} />
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {canMerge && (
          <button
            type="button"
            disabled={merging.busy || wait !== null}
            title={wait ?? undefined}
            onClick={() => void merging.run(undefined)}
            className={PRIMARY}
          >
            {mergeLabel(prs, failed)}
          </button>
        )}
        <button
          type="button"
          disabled={busy || running}
          onClick={() => void close('accept')}
          className={canMerge ? SECONDARY : PRIMARY}
        >
          Accept and close
        </button>
      </div>
      {wait !== null && <p className="text-[11px] text-fleet-text-secondary">{wait}</p>}
      <Refused reason={refused ?? merging.refused} />
    </section>
  );
}

/**
 * Cancel at the foot of an open job's sheet, quiet until asked, and asked
 * twice: it stops the crew and cleans up. A job already closing has none.
 */
export function CancelJob({ job }: { job: AgencyJob }): React.JSX.Element | null {
  const [asking, setAsking] = useState(false);
  if (job.state === 'closing') return null;
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="w-fit text-xs text-fleet-text-muted transition-colors hover:text-red-500 focus-ring dark:hover:text-red-400"
      >
        Cancel job
      </button>
    );
  }
  return <CancelConfirm job={job} onKeep={() => setAsking(false)} />;
}

/** Ask before a job is cancelled: what goes, and what is kept. */
export function CancelConfirm({
  job,
  onKeep
}: {
  job: AgencyJob;
  onKeep: () => void;
}): React.JSX.Element {
  const { busy, refused, run: close } = useClose(job);
  return (
    <div
      role="group"
      aria-label={`Cancel ${jobDisplayId(job.id)}`}
      className="flex flex-col gap-1.5 rounded-md border border-red-400/35 bg-fleet-bg p-2.5"
    >
      <p className="text-xs leading-relaxed text-fleet-text-secondary">
        Cancel {jobDisplayId(job.id)}? Crew stop, and worktrees with nothing left in them go. Work
        that is not committed or pushed is kept.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void close('cancel')}
          className="h-7 rounded-md border border-red-400/60 bg-fleet-surface-2 px-2.5 text-xs font-medium text-red-600 transition-colors hover:bg-fleet-surface-3 focus-ring disabled:opacity-50 dark:text-red-400"
        >
          Cancel job
        </button>
        <button type="button" disabled={busy} onClick={onKeep} className={SECONDARY}>
          Keep it
        </button>
      </div>
      <Refused reason={refused} />
    </div>
  );
}

/**
 * What closed jobs' cleanup kept on purpose or could not undo, each with
 * Retry and Dismiss. Retry looks again, so a worktree kept for its changes
 * goes once they are committed and pushed.
 */
export function LeftoverList({
  repoId,
  leftovers
}: {
  repoId: string;
  leftovers: AgencyLeftover[];
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {leftovers.map((leftover) => (
        <LeftoverRow key={leftover.id} repoId={repoId} leftover={leftover} />
      ))}
    </ul>
  );
}

function LeftoverRow({
  repoId,
  leftover
}: {
  repoId: string;
  leftover: AgencyLeftover;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const act = (action: 'retry' | 'dismiss'): void => {
    setBusy(true);
    void useAgencyStore
      .getState()
      .leftover(repoId, { resourceId: leftover.id, action })
      .finally(() => setBusy(false));
  };
  return (
    <li className="flex flex-col gap-1 rounded-md border border-fleet-border bg-fleet-bg p-2.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-fleet-text">
          {leftover.label}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {jobDisplayId(leftover.jobId)}
        </span>
      </div>
      <p
        className={
          leftover.status === 'failed'
            ? 'text-amber-700 dark:text-amber-400/90'
            : 'text-fleet-text-muted'
        }
      >
        {leftover.status === 'kept' ? 'Kept: ' : 'Not cleaned: '}
        {leftover.detail}
      </p>
      {leftover.path !== null && leftover.kind !== 'crew_pane' && (
        <p className="truncate font-mono text-[11px] text-fleet-text-subtle" title={leftover.path}>
          {leftover.path}
        </p>
      )}
      <div className="flex gap-1.5 pt-0.5">
        <button type="button" disabled={busy} onClick={() => act('retry')} className={SECONDARY}>
          Retry
        </button>
        <button type="button" disabled={busy} onClick={() => act('dismiss')} className={SECONDARY}>
          Dismiss
        </button>
      </div>
    </li>
  );
}
