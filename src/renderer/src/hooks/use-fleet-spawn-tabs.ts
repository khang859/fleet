import { useEffect } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';

/**
 * Open the tabs `fleet_spawn` asks for, and tell main each one is in the
 * layout. Main waits on the answer before it reports the session as started,
 * so a failure is answered too rather than left to time out.
 */
export function useFleetSpawnTabs(): void {
  useEffect(
    () =>
      window.fleet.agent.fleet.onOpenTab(({ requestId, ...req }) => {
        try {
          useWorkspaceStore.getState().openTerminalTab(req);
          window.fleet.agent.fleet.openTabDone({ requestId, error: null });
        } catch (err) {
          window.fleet.agent.fleet.openTabDone({
            requestId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }),
    []
  );
}
