import { useCallback, useRef } from 'react';
import { useToastStore } from '../store/toast-store';
import { useWorkspaceStore, collectPaneLeafs } from '../store/workspace-store';
import { useCwdStore } from '../store/cwd-store';
import { restartPane } from './use-terminal';

/**
 * CLAUDE_CONFIG_DIR is baked into a pane's env at spawn time, so a config change
 * only reaches terminals opened afterwards. Both the global setting (Copilot) and
 * the per-workspace overrides (Workspaces) need the same nudge, hence the shared hook.
 *
 * The debounce keeps a toast per keystroke from stacking while the user types a path.
 */
export function useConfigRestartToast(): () => void {
  const showToast = useToastStore((s) => s.show);

  const restartAllTerminals = useCallback((): void => {
    const wsState = useWorkspaceStore.getState();
    const cwds = useCwdStore.getState().cwds;
    const wsId = wsState.workspace.id;
    const terminalLeafs = wsState.workspace.tabs
      .filter((t) => !t.type || t.type === 'terminal')
      .flatMap((t) => collectPaneLeafs(t.splitRoot))
      .filter((leaf) => !leaf.paneType || leaf.paneType === 'terminal');

    for (const leaf of terminalLeafs) {
      const cwd = cwds.get(leaf.id) ?? leaf.cwd;
      void restartPane(leaf.id, cwd, wsId, leaf.shellProfileId);
    }
  }, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      showToast('Config updated — open new terminals to apply', {
        duration: 6000,
        action: { label: 'Restart Terminals', onClick: restartAllTerminals }
      });
    }, 800);
  }, [showToast, restartAllTerminals]);
}
