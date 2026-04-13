import { useState, useEffect } from 'react';
import type { UpdateStatus } from '../../../../shared/types';

type PiState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'updated'; version: string }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'error'; message: string };

export function UpdatesSection(): React.JSX.Element {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [appVersion, setAppVersion] = useState('');
  const [piVersion, setPiVersion] = useState<string | null>(null);
  const [piInstalled, setPiInstalled] = useState<boolean>(false);
  const [piState, setPiState] = useState<PiState>({ kind: 'idle' });

  useEffect(() => {
    void window.fleet.updates.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    void window.fleet.pi.getVersion().then((v) => {
      setPiVersion(v.version);
      setPiInstalled(v.installed);
    });
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

  useEffect(() => {
    if (piState.kind !== 'updated' && piState.kind !== 'up-to-date') return;
    const t = setTimeout(() => setPiState({ kind: 'idle' }), 4000);
    return () => clearTimeout(t);
  }, [piState.kind]);

  const checkPi = async (): Promise<void> => {
    setPiState({ kind: 'checking' });
    try {
      const result = await window.fleet.pi.checkForUpdates();
      setPiVersion(result.currentVersion);
      setPiInstalled(result.installed);
      if (!result.installed) {
        setPiState({
          kind: 'error',
          message: 'Pi agent not installed yet. Open a Pi tab to install.'
        });
        return;
      }
      const version = result.currentVersion ?? 'unknown';
      setPiState(result.updated ? { kind: 'updated', version } : { kind: 'up-to-date', version });
    } catch (err) {
      setPiState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Check failed'
      });
    }
  };

  const piChecking = piState.kind === 'checking';

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="text-sm text-neutral-300">Fleet v{appVersion}</div>

        {updateStatus.state === 'ready' ? (
          <button
            onClick={() => window.fleet.updates.installUpdate()}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
          >
            Restart to Update
          </button>
        ) : (
          <button
            onClick={() => {
              void window.fleet.updates.checkForUpdates();
            }}
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
            className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
            <div className="text-sm text-neutral-300">
              Downloading v{updateStatus.version}... {updateStatus.percent}%
            </div>
            <div className="w-full h-1.5 bg-neutral-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${updateStatus.percent}%` }}
              />
            </div>
          </div>
        )}

        {updateStatus.state === 'ready' && (
          <div className="text-sm text-blue-400">v{updateStatus.version} is ready to install.</div>
        )}

        {(updateStatus.state === 'downloading' || updateStatus.state === 'ready') &&
          updateStatus.releaseNotes && (
            <div className="mt-2">
              <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">
                Release Notes
              </div>
              <div className="text-sm text-neutral-400 bg-neutral-800 rounded-md p-3 max-h-[150px] overflow-y-auto whitespace-pre-wrap border border-neutral-700">
                {updateStatus.releaseNotes}
              </div>
            </div>
          )}
      </div>

      <div className="space-y-3 pt-4 border-t border-neutral-800">
        <div className="text-sm text-neutral-300">
          Pi agent{' '}
          {piInstalled && piVersion ? (
            `v${piVersion}`
          ) : (
            <span className="text-neutral-500">(not installed)</span>
          )}
        </div>

        <button
          onClick={() => {
            void checkPi();
          }}
          disabled={piChecking || !piInstalled}
          className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {piChecking ? 'Checking...' : 'Check for Pi Updates'}
        </button>

        {piState.kind === 'up-to-date' && (
          <div className="text-sm text-green-400">Pi agent is up to date.</div>
        )}
        {piState.kind === 'updated' && (
          <div className="text-sm text-blue-400">Updated Pi agent to v{piState.version}.</div>
        )}
        {piState.kind === 'error' && <div className="text-sm text-red-400">{piState.message}</div>}
      </div>
    </div>
  );
}
