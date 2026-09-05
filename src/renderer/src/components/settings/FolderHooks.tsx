import { useEffect } from 'react';
import { useHookStatusStore } from '../../store/hook-status-store';
import type { HookState } from '../../store/hook-status-store';

/** Fleet hooks exist only where the Copilot service does. */
export const HOOKS_SUPPORTED = window.fleet.platform === 'darwin';

const STATE_LABEL: Record<HookState, string> = {
  checking: 'Checking…',
  installed: 'Hooks installed',
  missing: 'Hooks not installed',
  error: 'Could not check this folder'
};

// Amber for both "we do not know" states. Red is reserved for something being
// wrong, and missing hooks are optional Copilot setup, not a broken workspace.
const STATE_DOT: Record<HookState, string> = {
  checking: 'bg-fleet-text-subtle',
  installed: 'bg-green-500',
  missing: 'bg-fleet-text-subtle',
  error: 'bg-amber-500'
};

/**
 * Fleet hook install/remove for one Claude config folder.
 *
 * Used by the default-folder setting and by each expanded workspace row, so
 * that everything pointed at the same folder shows the same answer and one
 * install updates all of them - the status lives in a folder-keyed store, not
 * in this component.
 *
 * `sharedWith` names every workspace resolving to this folder. Passing more
 * than one name is what turns an install into an action the user is told
 * affects several workspaces before they take it.
 *
 * Renders nothing where Copilot does not run. `initCopilot` returns before
 * registering the hook IPC handlers off macOS, so every check there rejects -
 * which would fill the Workspaces page with failed checks and buttons that
 * cannot work. Choosing a config folder stays available on every platform;
 * only the Copilot-specific setup disappears.
 */
export function FolderHooks({
  folder,
  sharedWith = []
}: {
  folder: string;
  sharedWith?: string[];
}): React.JSX.Element | null {
  const entry = useHookStatusStore((s) => s.byFolder[folder]);
  const check = useHookStatusStore((s) => s.check);
  const install = useHookStatusStore((s) => s.install);
  const remove = useHookStatusStore((s) => s.remove);

  useEffect(() => {
    if (!HOOKS_SUPPORTED) return;
    check(folder);
  }, [folder, check]);

  const state = entry?.state ?? 'checking';
  const busy = entry?.busy ?? false;
  const installed = state === 'installed';
  // Nothing to install *to* until a check has come back, and offering "Remove"
  // for a folder we could not read would be a guess.
  const actionable = state === 'installed' || state === 'missing';

  // After the hooks above, not before: the early return has to come last so the
  // hook order stays the same on every render.
  if (!HOOKS_SUPPORTED) return null;

  return (
    <div>
      <label className="text-xs text-fleet-text-muted block mb-1">Fleet hooks</label>
      <p className="text-xs text-fleet-text-subtle mb-1.5">
        Fleet hooks let Copilot receive session status and permission requests from this folder.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATE_DOT[state]}`} />
        <span className="text-xs text-fleet-text-secondary">{STATE_LABEL[state]}</span>
        <button
          disabled={!actionable || busy}
          onClick={() => void (installed ? remove(folder) : install(folder))}
          className="px-2 py-0.5 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Working…' : installed ? 'Remove Fleet hooks' : 'Install Fleet hooks'}
        </button>
        {state === 'error' && (
          <button
            onClick={() => check(folder)}
            className="px-2 py-0.5 text-xs text-fleet-text-secondary underline underline-offset-2 hover:text-fleet-text transition"
          >
            Retry
          </button>
        )}
      </div>
      <p className="text-xs text-fleet-text-subtle mt-1 break-all">{folder}</p>
      {sharedWith.length > 1 && (
        <p className="text-xs text-amber-500/70 mt-1">
          This folder is used by {sharedWith.join(' and ')}. Hook changes apply to all of them.
        </p>
      )}
    </div>
  );
}
