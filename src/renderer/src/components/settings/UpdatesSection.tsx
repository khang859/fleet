import { useState, useEffect } from 'react';
import type { UpdateStatus } from '../../../../shared/types';

export function UpdatesSection(): React.JSX.Element {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    void window.fleet.updates.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    const cleanup = window.fleet.updates.onUpdateStatus((status) => {
      setUpdateStatus(status);
      if (status.state === 'not-available') {
        setTimeout(() => setUpdateStatus({ state: 'idle' }), 3000);
      }
    });
    return () => {
      cleanup();
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="text-sm text-fleet-text-secondary">Fleet v{appVersion}</div>

        {updateStatus.state === 'ready' ? (
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

        {updateStatus.state === 'ready' && (
          <div className="text-sm fleet-accent-text">
            v{updateStatus.version} is ready to install.
          </div>
        )}

        {(updateStatus.state === 'downloading' || updateStatus.state === 'ready') &&
          updateStatus.releaseNotes && (
            <div className="mt-2">
              <div className="text-xs text-fleet-text-subtle uppercase tracking-wider mb-1">
                Release Notes
              </div>
              <div className="text-sm text-fleet-text-muted bg-fleet-surface-3 rounded-md p-3 max-h-[150px] overflow-y-auto whitespace-pre-wrap border border-fleet-border-strong">
                {updateStatus.releaseNotes}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
