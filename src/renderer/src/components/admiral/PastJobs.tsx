import { useState } from 'react';
import type { AgencyJob } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';

const STATE_LABEL: Partial<Record<AgencyJob['state'], string>> = {
  closed: 'Closed',
  cancelled: 'Cancelled',
  failed: 'Failed'
};

/** The repository's last jobs that ended, each with its record to export as Markdown. */
export function PastJobList({ jobs }: { jobs: AgencyJob[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col">
      {jobs.map((job) => (
        <PastJobRow key={job.id} job={job} />
      ))}
    </ul>
  );
}

function PastJobRow({ job }: { job: AgencyJob }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const exportIt = (): void => {
    setBusy(true);
    void window.fleet.agency
      .exportJob(job.id)
      .then((path) => setSaved(path))
      .finally(() => setBusy(false));
  };
  return (
    <li className="flex flex-col gap-0.5 border-b border-fleet-border py-1.5 last:border-b-0">
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 font-mono text-[11px] text-fleet-text-subtle">
          {jobDisplayId(job.id)}
        </span>
        <span className="min-w-0 flex-1 truncate text-fleet-text">{job.title}</span>
        <span className="shrink-0 text-fleet-text-muted">
          {STATE_LABEL[job.state] ?? job.state}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={exportIt}
          aria-label={`Export ${jobDisplayId(job.id)} as Markdown`}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring disabled:opacity-50"
        >
          Export
        </button>
      </div>
      {saved !== null && (
        <p role="status" className="truncate text-[11px] text-fleet-text-subtle" title={saved}>
          Saved to {saved}
        </p>
      )}
    </li>
  );
}
