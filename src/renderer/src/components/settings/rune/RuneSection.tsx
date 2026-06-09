import { CheckCircle2, AlertTriangle, RefreshCw, Download } from 'lucide-react';
import { useRuneStatus } from '../../../hooks/use-rune-status';
import { useRuneInstall } from '../../../hooks/use-rune-install';
import { useSettingsStore } from '../../../store/settings-store';
import { RuneInstallCommand } from '../../rune/RuneInstallCommand';
import { RUNE_REPO_URL, type RuneInstallResult } from '../../../../../shared/rune';
import { RuneSettingsEditor } from './RuneSettingsEditor';

/** Human-readable summary of a finished install/update run. */
function installMessage(result: RuneInstallResult): string {
  if (!result.status.installed) {
    return "Install ran, but Rune still isn't on your PATH. Restart Fleet, or add its install directory to your PATH, then Re-check.";
  }
  const { version } = result.status;
  if (result.previousVersion === null) return `Rune installed — v${version}.`;
  if (result.previousVersion === version) return `Already on the latest — v${version}.`;
  return `Updated v${result.previousVersion} → v${version}.`;
}

export function RuneSection(): React.JSX.Element {
  const { status, loading, recheck } = useRuneStatus();
  const { install, running, result, error } = useRuneInstall(recheck);
  const { settings, updateSettings } = useSettingsStore();

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl text-neutral-100 font-semibold">Rune</h1>
          <p className="text-sm text-neutral-500">
            Rune is the agent that runs your Kanban tasks. Fleet spawns it for every worker and
            orchestrator run, so it must be installed on your PATH.
          </p>
        </div>
        <button
          onClick={recheck}
          disabled={loading}
          className="flex shrink-0 items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40 transition active:scale-[0.97] disabled:active:scale-100"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Re-check
        </button>
      </header>

      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-400">Sessions: preferred agent</span>
        <select
          value={settings?.sessions.preferredAgent ?? 'rune'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'rune' || v === 'claude' || v === 'all') {
              void updateSettings({ sessions: { preferredAgent: v } });
            }
          }}
          className="bg-neutral-800 text-neutral-100 text-sm rounded px-2 py-1 border border-neutral-700"
        >
          <option value="rune">Rune</option>
          <option value="claude">Claude Code</option>
          <option value="all">All</option>
        </select>
      </div>

      {loading && status === null ? (
        <div className="text-sm text-neutral-400">Checking for Rune…</div>
      ) : status?.installed ? (
        <>
          <div className="flex items-center justify-between gap-2 rounded border border-green-700/40 bg-green-900/20 px-3 py-2 text-sm text-green-300">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                Rune is installed — <span className="font-mono">v{status.version}</span>.
              </span>
            </div>
            <button
              onClick={install}
              disabled={running}
              className="flex shrink-0 items-center gap-1 rounded border border-green-700/50 px-2 py-1 text-xs text-green-200 hover:bg-green-900/40 disabled:opacity-50 transition active:scale-[0.97] disabled:active:scale-100"
            >
              {running ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {running ? 'Updating…' : 'Update'}
            </button>
          </div>
          {result && <p className="text-xs text-neutral-400">{installMessage(result)}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <RuneSettingsEditor />
        </>
      ) : (
        <div className="space-y-3 rounded border border-amber-700/40 bg-amber-900/20 p-3">
          <div className="flex items-center gap-2 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Rune isn&apos;t installed. Kanban tasks can&apos;t run until it is.</span>
          </div>
          <button
            onClick={install}
            disabled={running}
            className="flex items-center gap-1.5 rounded bg-amber-600/90 px-3 py-1.5 text-sm font-medium text-amber-50 hover:bg-amber-600 disabled:opacity-50 transition active:scale-[0.97] disabled:active:scale-100"
          >
            {running ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {running ? 'Installing…' : 'Install Rune'}
          </button>
          {error && <p className="text-xs text-red-400">{error}</p>}
          {result && <p className="text-xs text-neutral-400">{installMessage(result)}</p>}
          <p className="text-xs text-neutral-400">Or run this in your terminal yourself:</p>
          <RuneInstallCommand />
          <p className="text-xs text-neutral-500">
            Then click Re-check.{' '}
            <button
              onClick={() => void window.fleet.shell.openExternal(RUNE_REPO_URL)}
              className="underline hover:text-neutral-300 transition active:scale-[0.97]"
            >
              Install guide
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
