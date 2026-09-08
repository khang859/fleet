import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AgentMarkdown } from '../agent/AgentMarkdown';
import { useUpdateStore } from '../../store/update-store';
import type { ReleaseNote } from '../../../../shared/release-notes';

/** A version in the list, and why it is worth pointing at. */
type Row = ReleaseNote & { badge: 'pending' | 'current' | null };

export function UpdatesSection(): React.JSX.Element {
  // Read from the store rather than subscribing here. This section is mounted
  // by opening Settings, which is almost always *after* the update was found -
  // a listener of its own only ever hears what arrives later, so the page the
  // pill and the sidebar dot point at was offering to check for an update it
  // had already been told about.
  const updateStatus = useUpdateStore((s) => s.status);
  // What can be installed, which outlives whatever the last check said.
  const staged = useUpdateStore((s) => s.staged);
  const dismissStatus = useUpdateStore((s) => s.dismissStatus);
  const [appVersion, setAppVersion] = useState('');
  // Every version this build ships notes for. Constant for the life of the
  // process, so it is asked for once rather than pushed with the status.
  const [history, setHistory] = useState<ReleaseNote[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    void window.fleet.updates.getVersion().then(setAppVersion);
    void window.fleet.updates.getReleaseHistory().then(setHistory);
  }, []);

  // Open the row for the version you are running, once both halves have
  // arrived. Only once: after that the open rows are the user's business, and a
  // late re-render must not spring the list back to how it started.
  useEffect(() => {
    if (seeded.current || appVersion === '' || history.length === 0) return;
    seeded.current = true;
    if (history.some((e) => e.version === appVersion)) setExpanded(new Set([appVersion]));
  }, [appVersion, history]);

  // "You're up to date" is an answer to a question the user just asked, so it
  // clears itself rather than standing as a permanent claim.
  useEffect(() => {
    if (updateStatus.state !== 'not-available') return;
    const timer = setTimeout(dismissStatus, 3000);
    return () => clearTimeout(timer);
  }, [updateStatus.state, dismissStatus]);

  function toggle(version: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(version)) next.add(version);
      return next;
    });
  }

  // The update you can act on right now, which this build's changelog may know
  // nothing about - so the updater's copy of its notes is the authority, and it
  // sits above the history rather than in it.
  const pending = staged ?? (updateStatus.state === 'downloading' ? updateStatus : null);
  const rows: Row[] = [];
  if (pending) {
    rows.push({
      version: pending.version,
      // A pending version already in the changelog (dev builds, a re-download)
      // would otherwise show an empty body when the updater sent no notes.
      notes:
        pending.releaseNotes.trim() ||
        (history.find((e) => e.version === pending.version)?.notes ?? ''),
      badge: 'pending'
    });
  }
  for (const entry of history) {
    // Shown once, in the pending position.
    if (entry.version === pending?.version) continue;
    rows.push({ ...entry, badge: entry.version === appVersion ? 'current' : null });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="text-sm text-fleet-text-secondary">Fleet v{appVersion}</div>

        {staged ? (
          <button
            onClick={() => window.fleet.updates.installUpdate()}
            className="px-3 py-1.5 text-sm fleet-accent-bg fleet-accent-bg-hover text-white rounded-md transition-colors active:scale-[0.97]"
          >
            Restart to Update
          </button>
        ) : (
          <button
            onClick={() => {
              void window.fleet.updates.checkForUpdates();
            }}
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
            className="px-3 py-1.5 text-sm bg-fleet-surface-3 hover:bg-fleet-surface-3 text-fleet-text rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] disabled:active:scale-100"
          >
            {updateStatus.state === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
        )}

        {updateStatus.state === 'not-available' && (
          <div className="text-sm text-green-400">You{"'"}re up to date.</div>
        )}

        {updateStatus.state === 'error' && (
          <div className="text-sm text-red-400">{updateStatus.message}</div>
        )}

        {updateStatus.state === 'downloading' && (
          <div className="space-y-2">
            <div className="text-sm text-fleet-text-secondary">
              Downloading v{updateStatus.version}... {updateStatus.percent}%
            </div>
            <div className="w-full h-1.5 bg-fleet-surface-3 rounded-full overflow-hidden">
              <div
                className="h-full fleet-accent-bg rounded-full transition-all duration-300"
                style={{ width: `${updateStatus.percent}%` }}
              />
            </div>
          </div>
        )}

        {staged && (
          <div className="text-sm fleet-accent-text">v{staged.version} is ready to install.</div>
        )}

        {rows.length > 0 && (
          <div className="mt-2">
            <div className="text-xs text-fleet-text-subtle uppercase tracking-wider mb-1">
              Release Notes
            </div>
            {/* Bounded: one row per release, and there is a release every few
                days, so the page must not grow with the project's age. */}
            <div className="max-h-[360px] overflow-y-auto rounded-md border border-fleet-border-strong bg-fleet-surface-3">
              {rows.map((row) => (
                <VersionRow
                  key={row.version}
                  row={row}
                  // A pending update is the reason the page is open: it stays
                  // open rather than being one more thing to click.
                  open={row.badge === 'pending' || expanded.has(row.version)}
                  onToggle={row.badge === 'pending' ? null : () => toggle(row.version)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VersionRow({
  row,
  open,
  onToggle
}: {
  row: Row;
  open: boolean;
  onToggle: (() => void) | null;
}): React.JSX.Element {
  const Chevron = open ? ChevronDown : ChevronRight;
  const header = (
    <>
      {/* No chevron on a row that cannot be closed - it would promise a
          control that is not there. */}
      {onToggle ? (
        <Chevron size={14} className="shrink-0 text-fleet-text-subtle" />
      ) : (
        <span className="w-[14px] shrink-0" />
      )}
      <span className="text-fleet-text-secondary">v{row.version}</span>
      {row.badge && (
        <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle border border-fleet-border-strong rounded px-1 py-px shrink-0">
          {row.badge === 'pending' ? 'Pending' : 'Current'}
        </span>
      )}
    </>
  );

  return (
    <div className="border-b border-fleet-border-strong last:border-b-0">
      {onToggle ? (
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-fleet-surface-2/50 transition text-left"
        >
          {header}
        </button>
      ) : (
        <div className="w-full flex items-center gap-2 px-3 py-2 text-sm">{header}</div>
      )}

      {open && row.notes !== '' && (
        <div className="px-3 pb-3 pl-[34px] text-fleet-text-muted">
          <AgentMarkdown streaming={false} className="text-xs leading-relaxed">
            {row.notes}
          </AgentMarkdown>
        </div>
      )}
    </div>
  );
}
