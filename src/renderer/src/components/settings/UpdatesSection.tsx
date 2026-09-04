import { useState, useEffect } from 'react';
import { AgentMarkdown } from '../agent/AgentMarkdown';
import { useUpdateStore } from '../../store/update-store';

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

  useEffect(() => {
    void window.fleet.updates.getVersion().then(setAppVersion);
  }, []);

  // "You're up to date" is an answer to a question the user just asked, so it
  // clears itself rather than standing as a permanent claim.
  useEffect(() => {
    if (updateStatus.state !== 'not-available') return;
    const timer = setTimeout(dismissStatus, 3000);
    return () => clearTimeout(timer);
  }, [updateStatus.state, dismissStatus]);

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

        {/* The staged update's notes win over a download still in flight: the
            one you can act on right now is the one worth reading about. */}
        {(() => {
          const notes =
            staged?.releaseNotes ??
            (updateStatus.state === 'downloading' ? updateStatus.releaseNotes : '');
          if (!notes) return null;
          return (
            <div className="mt-2">
              <div className="text-xs text-fleet-text-subtle uppercase tracking-wider mb-1">
                Release Notes
              </div>
              <div className="text-fleet-text-muted bg-fleet-surface-3 rounded-md p-3 max-h-[260px] overflow-y-auto border border-fleet-border-strong">
                <AgentMarkdown streaming={false} className="text-xs leading-relaxed">
                  {notes}
                </AgentMarkdown>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
