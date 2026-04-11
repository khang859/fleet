// src/renderer/src/components/Telescope/modes/panes-mode.ts
import { createElement } from 'react';
import { TerminalSquare } from 'lucide-react';
import { fuzzyMatch } from '../../../lib/commands';
import { collectPaneLeafs, useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

export function createPanesMode(): TelescopeMode {
  return {
    id: 'panes',
    label: 'Panes',
    icon: TerminalSquare,
    placeholder: 'Search open panes...',

    onSearch: (query: string): TelescopeItem[] => {
      const state = useWorkspaceStore.getState();
      const activeTab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (!activeTab) return [];

      const leafs = collectPaneLeafs(activeTab.splitRoot);

      const filtered = query
        ? leafs.filter((leaf) => {
            const label = leaf.label ?? leaf.paneType ?? 'terminal';
            return fuzzyMatch(query, label) || fuzzyMatch(query, leaf.cwd);
          })
        : leafs;

      return filtered.map((leaf) => {
        const isActive = leaf.id === state.activePaneId;
        return {
          id: leaf.id,
          icon: createElement(TerminalSquare, {
            size: 14,
            className: isActive ? 'text-green-400' : 'text-neutral-500'
          }),
          title: leaf.label ?? leaf.paneType ?? 'terminal',
          subtitle: leaf.cwd.replace(window.fleet.homeDir, '~'),
          meta: isActive ? 'active' : undefined,
          data: { paneId: leaf.id, cwd: leaf.cwd, paneType: leaf.paneType ?? 'terminal' }
        };
      });
    },

    onSelect: (item) => {
      const paneId = item.data?.paneId;
      if (typeof paneId !== 'string') return;
      useWorkspaceStore.getState().setActivePane(paneId);
      requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('fleet:refocus-pane', { detail: { paneId } }));
      });
    },

    renderPreview: () => null
  };
}
