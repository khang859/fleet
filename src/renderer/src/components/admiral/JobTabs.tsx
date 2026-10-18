import type { AgencySnapshot } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';
import { waitingCount } from '../../store/agency-store';
import { jobStatus, TONE_DOT } from './job-view';

/**
 * The tabs in an Admiral pane's header: the lobby, pinned first, then one per
 * open job. The lobby is a place of its own, where new work is briefed, so it
 * gets a labelled tab that lights up while it is on screen rather than a "+"
 * that reads as "add". A dot says which tabs want something - amber for a
 * question, green while a job is being worked on - so a glance at the header
 * answers "where am I needed".
 */
export function JobTabs({
  snapshot,
  activeJobId,
  working,
  onSelect
}: {
  snapshot: AgencySnapshot | undefined;
  /** The job on screen, or null for the lobby. */
  activeJobId: number | null;
  /** The jobs with a turn running. */
  working: ReadonlySet<number>;
  onSelect: (jobId: number | null) => void;
}): React.JSX.Element {
  const jobs = snapshot?.jobs ?? [];
  const lobbyAsking = waitingCount(snapshot, null) > 0;

  return (
    <div
      role="tablist"
      aria-label="Lobby and jobs"
      className="flex min-w-0 flex-1 items-center gap-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={activeJobId === null}
        title="Brief new work and see past jobs"
        onClick={() => onSelect(null)}
        className={`${TAB} shrink-0 ${activeJobId === null ? SELECTED : IDLE}`}
      >
        {lobbyAsking && <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />}
        Lobby
      </button>
      <div className="mx-0.5 h-4 w-px shrink-0 bg-fleet-border" />
      {jobs.length === 0 ? (
        <span className="truncate px-1 text-xs text-fleet-text-subtle">
          {(snapshot?.pastJobs.length ?? 0) > 0 ? 'No open jobs' : 'No jobs yet'}
        </span>
      ) : (
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {jobs.map((job) => {
            const selected = job.id === activeJobId;
            const status = jobStatus(job, {
              asking: waitingCount(snapshot, job.id) > 0,
              working: working.has(job.id)
            });
            const dot = status.tone === 'amber' || status.tone === 'green';
            return (
              <button
                key={job.id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={`${jobDisplayId(job.id)} · ${job.title} · ${status.label}`}
                onClick={() => onSelect(job.id)}
                className={`${TAB} max-w-[200px] min-w-[88px] shrink ${selected ? SELECTED : IDLE}`}
              >
                {dot && (
                  <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`} />
                )}
                <span className="truncate">{job.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TAB = 'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-ring';
const SELECTED = 'bg-fleet-surface-2 text-fleet-text';
const IDLE = 'text-fleet-text-muted hover:bg-fleet-surface-2/60 hover:text-fleet-text-secondary';
