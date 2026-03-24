import { collectPaneIds } from '../../store/workspace-store';
import type { PaneNode } from '../../../../shared/types';
import type { AgentVisualState } from '../../../../shared/types';

/** Convert workspace tabs/panes into AgentVisualState[] for the ship manager.
 *  Each tab = parent ship. Each pane in the tab = trailing subagent ship. */
export function workspaceToAgents(
  tabs: Array<{ id: string; label: string; splitRoot: PaneNode }>
): AgentVisualState[] {
  return tabs.map((tab) => {
    const paneIds = collectPaneIds(tab.splitRoot);
    return {
      paneId: tab.id,
      label: tab.label,
      state: 'idle' as const,
      subAgents:
        paneIds.length > 1
          ? paneIds.map((pid) => ({
              paneId: pid,
              label: pid.slice(0, 8),
              state: 'idle' as const,
              subAgents: [],
              uptime: 0
            }))
          : [],
      uptime: 0
    };
  });
}
