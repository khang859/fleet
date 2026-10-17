import { useEffect, useState } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { askAdmiralFrom } from '../../lib/ask-admiral';
import { AdmiralGlyph } from '../admiral/AdmiralGlyph';

const FIELD =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text placeholder:text-fleet-text-subtle';

/**
 * "Ask the Admiral" on a Settings › Agency page: a button that opens a line
 * for the request and, with more than one project, which project's Admiral
 * to ask. Sending opens that Admiral with the page and the request.
 */
export function AskAdmiralButton({ page }: { page: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<AgencyRepoRef[] | null>(null);

  useEffect(() => {
    void window.fleet.agency.projects.list().then((list) => setProjects(list.map((p) => p.repo)));
  }, []);

  if (projects === null || projects.length === 0) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ml-2 flex items-center gap-1.5 rounded px-2 py-1 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
      >
        <AdmiralGlyph size={13} className="shrink-0" />
        Ask the Admiral
      </button>
      {open && <AskAdmiralForm page={page} projects={projects} onSent={() => setOpen(false)} />}
    </div>
  );
}

/**
 * The request line itself. With one project there is nothing to pick; in
 * project setup the pane's own repository is the only one.
 */
export function AskAdmiralForm({
  page,
  projects,
  placeholder = 'For example: make jobs cheaper',
  onSent
}: {
  page: string;
  projects: AgencyRepoRef[];
  placeholder?: string;
  onSent?: () => void;
}): React.JSX.Element {
  const [repoId, setRepoId] = useState(projects.at(0)?.repoId ?? '');
  const [request, setRequest] = useState('');
  const [sending, setSending] = useState(false);
  const repo = projects.find((p) => p.repoId === repoId) ?? projects.at(0);
  const text = request.trim();

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (text === '' || repo === undefined) return;
    setSending(true);
    try {
      if ((await askAdmiralFrom(page, repo, text)) !== 'refused') {
        setRequest('');
        onSent?.();
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={(e) => void send(e)} className="flex flex-wrap items-center gap-2">
      {projects.length > 1 && (
        <select
          aria-label="Ask the Admiral of"
          value={repo?.repoId ?? ''}
          onChange={(e) => setRepoId(e.target.value)}
          className={`${FIELD} w-[180px]`}
        >
          {projects.map((p) => (
            <option key={p.repoId} value={p.repoId}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <input
        aria-label="Request for the Admiral"
        value={request}
        maxLength={2_000}
        placeholder={placeholder}
        onChange={(e) => setRequest(e.target.value)}
        className={`${FIELD} min-w-[220px] flex-1`}
      />
      <button
        type="submit"
        disabled={sending || text === ''}
        className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-blue-500 focus-ring disabled:bg-fleet-surface-3 disabled:text-fleet-text-subtle"
      >
        {sending ? 'Opening…' : 'Ask'}
      </button>
    </form>
  );
}
