import { useCallback } from 'react';
import { TabItem } from './TabItem';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { serializePane } from '../hooks/use-terminal';

export function Sidebar() {
  const { workspace, activeTabId, setActiveTab, closeTab, renameTab, addTab } =
    useWorkspaceStore();
  const { getTabBadge } = useNotificationStore();

  const handleCloseTab = useCallback((tabId: string) => {
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Serialize terminal content before React unmounts the components
    const serializedPanes = new Map<string, string>();
    for (const paneId of collectPaneIds(tab.splitRoot)) {
      const content = serializePane(paneId);
      if (content) serializedPanes.set(paneId, content);
    }
    closeTab(tabId, serializedPanes);
  }, [workspace.tabs, closeTab]);

  return (
    <div className="flex flex-col h-full w-56 bg-neutral-900 border-r border-neutral-800">
      {/* Drag region + workspace label */}
      <div
        className="px-3 pt-8 pb-3 text-xs font-semibold text-neutral-500 uppercase tracking-wider"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {workspace.label}
      </div>

      {/* Tab list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {workspace.tabs.map((tab) => (
          <TabItem
            key={tab.id}
            id={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            badge={getTabBadge(collectPaneIds(tab.splitRoot))}
            onClick={() => {
              setActiveTab(tab.id);
              const paneIds = collectPaneIds(tab.splitRoot);
              for (const paneId of paneIds) {
                useNotificationStore.getState().clearPane(paneId);
                window.fleet.notifications.paneFocused({ paneId });
              }
            }}
            onClose={() => handleCloseTab(tab.id)}
            onRename={(newLabel) => renameTab(tab.id, newLabel)}
          />
        ))}
      </div>

      {/* New tab button */}
      <div className="p-2 border-t border-neutral-800">
        <button
          className="w-full px-3 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
          onClick={() => addTab('Shell', window.fleet.homeDir)}
          title="New Tab (Cmd+T)"
        >
          + New Tab
        </button>
      </div>
    </div>
  );
}
