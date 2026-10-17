import { useCallback, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { AgencyProjectSummary, ClientFileView } from '../../../../shared/agency-projects';
import { useSettingsNavStore } from '../../store/settings-nav-store';

const FIELD =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text';

/**
 * Settings › Agency › Admiral › Client file: what the Admiral remembers about
 * how the client likes to work on each project, as the Markdown it is. Saving
 * here writes the whole file, so the client's own edits always win; it also
 * keeps a change made outside Fleet, which the Admiral ignores until then.
 */
export function ClientFileEditor(): React.JSX.Element {
  const [projects, setProjects] = useState<AgencyProjectSummary[] | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [file, setFile] = useState<ClientFileView | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.fleet.agency.projects.list().then((list) => {
      setProjects(list);
      const asked = useSettingsNavStore.getState().clientFileRepoId;
      const first = list.find((p) => p.repo.repoId === asked) ?? list.at(0);
      setRepoId(first?.repo.repoId ?? null);
    });
  }, []);

  const load = useCallback(async (id: string): Promise<void> => {
    const view = await window.fleet.agency.projects.clientFile(id);
    setFile(view);
    setDraft(view.text ?? '');
  }, []);

  useEffect(() => {
    if (repoId !== null) void load(repoId);
  }, [repoId, load]);

  const save = async (): Promise<void> => {
    if (repoId === null) return;
    setSaving(true);
    try {
      await window.fleet.agency.projects.writeClientFile({ repoId, text: draft });
      await load(repoId);
    } finally {
      setSaving(false);
    }
  };

  const unchanged = file !== null && draft === (file.text ?? '') && !file.changedOutside;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <h3 className="flex-1 text-sm font-medium text-fleet-text">Client file</h3>
        {projects !== null && projects.length > 0 && (
          <select
            aria-label="Project"
            value={repoId ?? ''}
            onChange={(e) => setRepoId(e.target.value)}
            className={`${FIELD} w-[220px]`}
          >
            {projects.map((p) => (
              <option key={p.repo.repoId} value={p.repo.repoId}>
                {p.repo.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="text-xs text-fleet-text-subtle">
        How you like to work on the project, which the Admiral reads at the start of every job. It
        adds lines only when you approve them. Your edits here always win.
      </p>

      {projects?.length === 0 ? (
        <p className="text-sm text-fleet-text-muted">
          Open an Admiral on a project to start its client file.
        </p>
      ) : (
        <>
          {file?.changedOutside === true && (
            <div className="flex items-start gap-1.5 rounded border border-amber-400/35 bg-amber-400/5 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400/90">
              <CircleAlert size={13} className="mt-px shrink-0" />
              <span>
                This file changed outside Fleet. The Admiral works from the version Fleet last wrote
                until you save it here.
              </span>
            </div>
          )}
          <textarea
            aria-label="Client file"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            placeholder={'# My project\n- Open PRs as drafts.'}
            className={`${FIELD} block h-60 w-full resize-y font-mono text-xs leading-relaxed`}
          />
          <div className="flex items-center gap-3">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-fleet-text-subtle"
              title={file?.path}
            >
              {file?.path}
            </span>
            <button
              type="button"
              disabled={saving || unchanged || repoId === null}
              onClick={() => void save()}
              className="rounded bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text transition active:scale-[0.97] disabled:text-fleet-text-subtle disabled:active:scale-100"
            >
              {file?.changedOutside === true && draft === (file.text ?? '')
                ? 'Keep this version'
                : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
