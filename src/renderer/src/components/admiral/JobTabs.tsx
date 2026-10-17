import { Plus } from 'lucide-react';
import type { AgencySnapshot } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';
import { waitingCount } from '../../store/agency-store';
import { jobStatus, TONE_DOT } from './job-view';

/**
 * The job tabs in an Admiral pane's header, one per open job, and the new
 * brief button that goes back to the lobby. A dot says which jobs want
 * something - amber for a question, green while one is being worked on - so
 * a glance at the header answers "where am I needed".
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
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {jobs.length === 0 ? (
        <span className="truncate px-1 text-xs text-fleet-text-subtle">No jobs yet</span>
      ) : (
        <div
          role="tablist"
          aria-label="Jobs"
          className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
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
                className={`flex h-7 max-w-[200px] min-w-[88px] shrink items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-ring ${
                  selected
                    ? 'bg-fleet-surface-2 text-fleet-text'
                    : 'text-fleet-text-muted hover:bg-fleet-surface-2/60 hover:text-fleet-text-secondary'
                }`}
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
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-label="New brief"
        aria-pressed={activeJobId === null}
        title={jobs.length === 0 ? 'Brief the Admiral' : 'New brief'}
        className={`relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-ring ${
          activeJobId === null && jobs.length > 0
            ? 'bg-fleet-surface-2 text-fleet-text'
            : 'text-fleet-text-muted hover:bg-fleet-surface-2/60 hover:text-fleet-text'
        }`}
      >
        <Plus size={14} />
        {lobbyAsking && (
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400" />
        )}
      </button>
    </div>
  );
}
