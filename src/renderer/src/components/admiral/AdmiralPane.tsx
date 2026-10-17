import { useEffect, useState } from 'react';
import { Compass } from 'lucide-react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { useSettingsStore } from '../../store/settings-store';
import { openSettings } from '../../store/settings-nav-store';
import { focusPane } from '../../lib/focus-pane';

/**
 * The Admiral pane: one repository's agency, where the client briefs work,
 * answers questions and receives results.
 *
 * For now it holds the pane's place in the layout and its claim on the
 * repository - one Admiral per repository, checked in main whenever the pane
 * mounts, including after a restart or an undone close. The chat and the job
 * sheet build on this.
 */
export function AdmiralPane({
  paneId,
  repo
}: {
  paneId: string;
  repo: AgencyRepoRef | undefined;
}): React.JSX.Element {
  const enabled = useSettingsStore((s) => s.settings?.agency.enabled ?? false);
  const [owner, setOwner] = useState<string | null>(null);
  const repoId = repo?.repoId;

  useEffect(() => {
    if (!enabled || repoId === undefined) return;
    let live = true;
    void window.fleet.agency.claimAdmiral({ repoId, paneId }).then((claim) => {
      if (live) setOwner(claim.ok ? null : claim.ownerPaneId);
    });
    return () => {
      live = false;
    };
  }, [enabled, repoId, paneId]);

  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-fleet-glass-chrome px-6 text-center">
      <div className="flex items-center gap-2 text-fleet-text">
        <Compass size={18} className="text-blue-400" />
        <span className="text-sm font-medium">Admiral</span>
        {repo && (
          <span className="rounded border border-fleet-border-strong px-1.5 py-px text-xs text-fleet-text-secondary">
            {repo.name}
          </span>
        )}
      </div>
      {!enabled ? (
        <>
          <p className="max-w-sm text-sm text-fleet-text-muted">
            Admiral is turned off. Turn it on in Settings to brief work here.
          </p>
          <button
            type="button"
            onClick={() => openSettings('agencyAdmiral')}
            className="rounded px-2.5 py-1 text-xs text-fleet-text-secondary border border-fleet-border-strong hover:text-fleet-text hover:bg-fleet-surface-2 transition"
          >
            Open Admiral settings
          </button>
        </>
      ) : !repo ? (
        <p className="max-w-sm text-sm text-fleet-text-muted">An Admiral needs a git repository.</p>
      ) : owner !== null ? (
        <>
          <p className="max-w-sm text-sm text-fleet-text-muted">
            The Admiral for {repo.name} is open in another pane.
          </p>
          <button
            type="button"
            onClick={() => void focusPane(owner)}
            className="rounded px-2.5 py-1 text-xs text-fleet-text-secondary border border-fleet-border-strong hover:text-fleet-text hover:bg-fleet-surface-2 transition"
          >
            Show it
          </button>
        </>
      ) : (
        <p className="max-w-sm break-all font-mono text-xs text-fleet-text-subtle">{repo.root}</p>
      )}
    </div>
  );
}
