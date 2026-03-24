import { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { serializePane } from '../hooks/use-terminal';
import { injectLiveCwd } from '../lib/workspace-utils';
import type { Workspace } from '../../../shared/types';

export function WorkspacePicker(): React.JSX.Element {
  const { workspace, activeTabId, setActiveTab, addTab, closeTab } = useWorkspaceStore();
  const { getTabBadge } = useNotificationStore();
  const [savedWorkspaces, setSavedWorkspaces] = useState<Workspace[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNameInput, setShowNameInput] = useState(false);
  const [newName, setNewName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Load saved workspaces on mount and when menu opens
  useEffect(() => {
    void window.fleet.layout.list().then(({ workspaces }) => {
      setSavedWorkspaces(workspaces.filter((w) => w.id !== workspace.id));
    });
  }, [menuOpen, workspace.id]);

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleNewWorkspace = (): void => {
    setMenuOpen(false);
    setNewName('');
    setShowNameInput(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const commitNewWorkspace = async (): Promise<void> => {
    const name = newName.trim();
    setShowNameInput(false);
    setNewName('');
    if (!name) return;

    // Flush current workspace to disk before switching away
    const storeState = useWorkspaceStore.getState();
    await window.fleet.layout.save({
      workspace: {
        ...storeState.workspace,
        activeTabId: storeState.activeTabId ?? undefined,
        activePaneId: storeState.activePaneId ?? undefined,
        tabs: storeState.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: injectLiveCwd(tab.splitRoot)
        }))
      }
    });

    const newWs: Workspace = {
      id: crypto.randomUUID(),
      label: name,
      tabs: []
    };
    useWorkspaceStore.getState().switchWorkspace(newWs);
    setTimeout(() => {
      useWorkspaceStore.getState().addTab('Shell', window.fleet.homeDir);
    }, 0);
  };

  const handleSaveCurrent = async (): Promise<void> => {
    const state = useWorkspaceStore.getState();
    const workspaceWithLiveCwds = {
      ...workspace,
      activeTabId: state.activeTabId ?? undefined,
      activePaneId: state.activePaneId ?? undefined,
      tabs: workspace.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(tab.splitRoot)
      }))
    };
    await window.fleet.layout.save({ workspace: workspaceWithLiveCwds });
    setMenuOpen(false);
  };

  const handleSwitchWorkspace = async (ws: Workspace): Promise<void> => {
    // Flush current workspace to disk before switching away
    const storeState = useWorkspaceStore.getState();
    await window.fleet.layout.save({
      workspace: {
        ...storeState.workspace,
        activeTabId: storeState.activeTabId ?? undefined,
        activePaneId: storeState.activePaneId ?? undefined,
        tabs: storeState.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: injectLiveCwd(tab.splitRoot)
        }))
      }
    });

    useWorkspaceStore.getState().switchWorkspace(ws);
    setMenuOpen(false);
    // Add a default tab if the workspace is empty
    setTimeout(() => {
      const loaded = useWorkspaceStore.getState();
      if (loaded.workspace.tabs.length === 0) {
        loaded.addTab('Shell', window.fleet.homeDir);
      }
    }, 0);
  };

  const handleDeleteWorkspace = async (wsId: string): Promise<void> => {
    await window.fleet.layout.delete(wsId);
    setSavedWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
  };

  const handleCloseTab = (tabId: string): void => {
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const serializedPanes = new Map<string, string>();
    for (const paneId of collectPaneIds(tab.splitRoot)) {
      const content = serializePane(paneId);
      if (content) serializedPanes.set(paneId, content);
    }
    closeTab(tabId, serializedPanes);
  };

  // Current workspace is always expanded
  const isCurrentExpanded = expandedIds.has(workspace.id) || true;

  return (
    <div className="flex flex-col h-full">
      {/* Current workspace header */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-neutral-400 uppercase tracking-wider"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <button
          className="flex items-center gap-1 flex-1 text-left hover:text-neutral-200 transition-colors"
          onClick={() => toggleExpanded(workspace.id)}
        >
          <ChevronIcon expanded={isCurrentExpanded} />
          <span className="truncate">{workspace.label}</span>
        </button>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="px-1 text-neutral-600 hover:text-neutral-300 transition-colors"
          title="Workspace actions"
        >
          &#8943;
        </button>
      </div>

      {/* Workspace actions dropdown */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="relative z-20 mx-2 mb-1 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg py-1">
            <button
              className="w-full px-3 py-1.5 text-sm text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={handleNewWorkspace}
            >
              New Workspace
            </button>
            <button
              className="w-full px-3 py-1.5 text-sm text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => {
                void handleSaveCurrent();
              }}
            >
              Save Current
            </button>
            {savedWorkspaces.length > 0 && (
              <div className="border-t border-neutral-700 mt-1 pt-1">
                <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
                  Switch to
                </div>
                {savedWorkspaces.map((ws) => (
                  <div key={ws.id} className="flex items-center hover:bg-neutral-700">
                    <button
                      className="flex-1 px-3 py-1.5 text-sm text-neutral-300 hover:text-white text-left truncate"
                      onClick={() => void handleSwitchWorkspace(ws)}
                    >
                      {ws.label}
                      <span className="text-neutral-600 ml-1 text-xs">
                        ({ws.tabs.length} tab{ws.tabs.length !== 1 ? 's' : ''})
                      </span>
                    </button>
                    <button
                      className="px-2 text-neutral-600 hover:text-red-400 text-xs"
                      onClick={() => {
                        void handleDeleteWorkspace(ws.id);
                      }}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Inline new workspace name input */}
      {showNameInput && (
        <div className="mx-2 mb-1">
          <input
            ref={nameInputRef}
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitNewWorkspace();
              if (e.key === 'Escape') {
                setShowNameInput(false);
                setNewName('');
              }
            }}
            onBlur={() => {
              void commitNewWorkspace();
            }}
            placeholder="Workspace name..."
            className="w-full px-2 py-1 text-sm bg-neutral-800 text-white border border-neutral-600 rounded focus:border-blue-500 focus:outline-none"
          />
        </div>
      )}

      {/* Current workspace tabs (tree) */}
      <div className="flex-1 overflow-y-auto px-1 space-y-0.5">
        {workspace.tabs.map((tab) => {
          const paneIds = collectPaneIds(tab.splitRoot);
          const badge = getTabBadge(paneIds);
          const isActive = tab.id === activeTabId;

          return (
            <TreeTab
              key={tab.id}
              label={tab.label}
              isActive={isActive}
              badge={badge}
              paneCount={paneIds.length}
              onClick={() => {
                setActiveTab(tab.id);
                for (const paneId of paneIds) {
                  useNotificationStore.getState().clearPane(paneId);
                  window.fleet.notifications.paneFocused({ paneId });
                }
              }}
              onClose={() => handleCloseTab(tab.id)}
            />
          );
        })}
      </div>

      {/* Saved workspaces (collapsed tree nodes) */}
      {savedWorkspaces.length > 0 && (
        <div className="border-t border-neutral-800 pt-1 pb-1 px-1">
          {savedWorkspaces.map((ws) => {
            const isExpanded = expandedIds.has(ws.id);
            return (
              <div key={ws.id}>
                <div className="flex items-center gap-1 px-1 py-1 text-xs text-neutral-600 hover:text-neutral-400 transition-colors">
                  <button
                    className="flex items-center gap-1 flex-1 text-left"
                    onClick={() => toggleExpanded(ws.id)}
                  >
                    <ChevronIcon expanded={isExpanded} />
                    <span className="truncate font-medium">{ws.label}</span>
                    <span className="text-neutral-700 ml-auto text-[10px]">{ws.tabs.length}</span>
                  </button>
                  <button
                    className="px-1 text-neutral-700 hover:text-neutral-400 text-[10px]"
                    onClick={() => void handleSwitchWorkspace(ws)}
                    title="Switch to this workspace"
                  >
                    &#8594;
                  </button>
                </div>
                {isExpanded && (
                  <div className="ml-3 space-y-0.5">
                    {ws.tabs.map((tab) => (
                      <div
                        key={tab.id}
                        className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-neutral-600 rounded"
                      >
                        <FileIcon />
                        <span className="truncate">{tab.label}</span>
                      </div>
                    ))}
                    {ws.tabs.length === 0 && (
                      <div className="px-2 py-0.5 text-xs text-neutral-700 italic">(empty)</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* New tab button */}
      <div className="p-2 border-t border-neutral-800">
        <button
          className="w-full px-3 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
          onClick={() => addTab('Shell', window.fleet.homeDir)}
          title="New Tab (Ctrl+T)"
        >
          + New Tab
        </button>
      </div>
    </div>
  );
}

// --- Small helper components ---

function ChevronIcon({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      fill="currentColor"
    >
      <path
        d="M4.5 2L8.5 6L4.5 10"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className="flex-shrink-0 text-neutral-600"
      fill="none"
      stroke="currentColor"
    >
      <rect x="1" y="1" width="6" height="8" rx="0.5" strokeWidth="1" />
      <path d="M7 1L7 3.5H9.5" strokeWidth="1" />
    </svg>
  );
}

type BadgeLevel = 'permission' | 'error' | 'info' | 'subtle';

const BADGE_COLORS: Record<BadgeLevel, string> = {
  permission: 'bg-amber-400',
  error: 'bg-red-400',
  info: 'bg-blue-400',
  subtle: 'bg-neutral-500'
};

function TreeTab({
  label,
  isActive,
  badge,
  paneCount,
  onClick,
  onClose
}: {
  label: string;
  isActive: boolean;
  badge: BadgeLevel | null;
  paneCount: number;
  onClick: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`
        group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer rounded-md text-sm
        ${
          isActive
            ? 'bg-neutral-700/60 text-white border-l-2 border-blue-500'
            : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
        }
      `}
      onClick={onClick}
      title={label}
    >
      {badge && !isActive && (
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${BADGE_COLORS[badge]} ${badge === 'permission' ? 'animate-pulse' : ''}`}
        />
      )}
      <FileIcon />
      <span className="flex-1 truncate">{label}</span>
      {paneCount > 1 && <span className="text-[10px] text-neutral-600">{paneCount}</span>}
      <button
        className="opacity-0 group-hover:opacity-100 px-0.5 text-neutral-500 hover:text-red-400 transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        &times;
      </button>
    </div>
  );
}
