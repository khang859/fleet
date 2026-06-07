import { CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { useRuneStatus } from '../../../hooks/use-rune-status';
import { RuneInstallCommand } from '../../rune/RuneInstallCommand';
import { RUNE_REPO_URL } from '../../../../../shared/rune';

export function RuneSection(): React.JSX.Element {
  const { status, loading, recheck } = useRuneStatus();

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

      {loading && status === null ? (
        <div className="text-sm text-neutral-400">Checking for Rune…</div>
      ) : status?.installed ? (
        <div className="flex items-center gap-2 rounded border border-green-700/40 bg-green-900/20 px-3 py-2 text-sm text-green-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Rune is installed — <span className="font-mono">v{status.version}</span>.
          </span>
        </div>
      ) : (
        <div className="space-y-3 rounded border border-amber-700/40 bg-amber-900/20 p-3">
          <div className="flex items-center gap-2 text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Rune isn&apos;t installed. Kanban tasks can&apos;t run until it is.</span>
          </div>
          <p className="text-xs text-neutral-400">Install it by running this in your terminal:</p>
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
