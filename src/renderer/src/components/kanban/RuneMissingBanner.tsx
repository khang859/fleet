import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useRuneStatus } from '../../hooks/use-rune-status';
import { RuneInstallCommand } from '../rune/RuneInstallCommand';

/**
 * Pre-flight gate for the Kanban board: when Rune isn't installed, tasks silently fail to spawn,
 * so surface one clear, high-severity banner at the source (NN/g) instead of letting cards pile
 * up failing. Renders nothing while loading or when Rune is present — no premature/false alarm.
 */
export function RuneMissingBanner(): React.JSX.Element | null {
  const { status, loading, recheck } = useRuneStatus();
  if (status === null || status.installed) return null;

  return (
    <div className="space-y-2 border-b border-amber-700/40 bg-amber-900/20 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Rune isn&apos;t installed, so tasks can&apos;t run. Install it, then re-check.
          </span>
        </div>
        <button
          onClick={recheck}
          disabled={loading}
          className="flex shrink-0 items-center gap-1 rounded border border-amber-700/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Re-check
        </button>
      </div>
      <RuneInstallCommand />
    </div>
  );
}
