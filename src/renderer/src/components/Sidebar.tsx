import { useCallback, useState, useEffect, useRef } from 'react';
import { TabItem } from './TabItem';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { clearCreatedPty, serializePane } from '../hooks/use-terminal';
import type { Workspace } from '../../../shared/types';

const AUTO_SAVE_DEBOUNCE_MS = 2000;

export function Sidebar() {
  const {
    workspace,
    activeTabId,
    setActiveTab,
    closeTab,
    renameTab,
    addTab,
    reorderTab,
    isDirty,
    markClean,
  } = useWorkspaceStore();
  const { getTabBadge } = useNotificationStore();

  // --- Drag-and-drop state ---
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'above' | 'below' } | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (dragIndex === null) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'above' : 'below';
    setDropTarget({ index, position });
  }, [dragIndex]);

  const handleDrop = useCallback((_targetIndex: number) => {
    if (dragIndex === null || !dropTarget) return;
    const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
    // Adjust toIndex if dragging from before the drop point
    const adjustedTo = dragIndex < toIndex ? toIndex - 1 : toIndex;
    if (dragIndex !== adjustedTo) {
      reorderTab(dragIndex, adjustedTo);
    }
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex, dropTarget, reorderTab]);

  // Clear drag state on drag end (even if drop didn't fire)
  useEffect(() => {
    const handleDragEnd = () => {
      setDragIndex(null);
      setDropTarget(null);
    };
    window.addEventListener('dragend', handleDragEnd);
    return () => window.removeEventListener('dragend', handleDragEnd);
  }, []);

  // --- Workspace switch confirmation ---
  const [switchConfirmId, setSwitchConfirmId] = useState<string | null>(null);

  // --- Saved workspaces ---
  const [savedWorkspaces, setSavedWorkspaces] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    window.fleet.layout.list().then((res) => {
      setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
    });
  }, []);

  const handleSwitchWorkspace = useCallback((wsId: string) => {
    // If there are running terminals, confirm first
    if (workspace.tabs.length > 0) {
      setSwitchConfirmId(wsId);
      return;
    }
    doSwitchWorkspace(wsId);
  }, [workspace.tabs.length]);

  const doSwitchWorkspace = useCallback(async (wsId: string) => {
    setSwitchConfirmId(null);
    const loaded = await window.fleet.layout.load(wsId);
    useWorkspaceStore.getState().loadWorkspace(loaded);
  }, []);

  // --- Auto-save with debounce ---
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const state = useWorkspaceStore.getState();
      window.fleet.layout.save({
        workspace: state.workspace,
      }).then(() => {
        markClean();
        // Refresh saved workspaces list
        window.fleet.layout.list().then((res) => {
          setSavedWorkspaces(res.workspaces.map((w) => ({ id: w.id, label: w.label })));
        });
      });
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isDirty, workspace.tabs, workspace.label, markClean]);

  // --- New workspace creation ---
  const [showNewWsInput, setShowNewWsInput] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const newWsInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showNewWsInput && newWsInputRef.current) {
      newWsInputRef.current.focus();
    }
  }, [showNewWsInput]);

  const commitNewWorkspace = useCallback(() => {
    const name = newWsName.trim();
    setShowNewWsInput(false);
    setNewWsName('');
    if (!name) return;

    // Save current workspace first
    const state = useWorkspaceStore.getState();
    window.fleet.layout.save({ workspace: state.workspace });

    // Kill current PTYs
    const currentPaneIds = state.getAllPaneIds();
    for (const paneId of currentPaneIds) {
      window.fleet.pty.kill(paneId);
      clearCreatedPty(paneId);
    }

    // Create fresh workspace
    const newWs: Workspace = {
      id: crypto.randomUUID(),
      label: name,
      tabs: [],
    };
    state.loadWorkspace(newWs);

    // Add a default tab
    setTimeout(() => {
      useWorkspaceStore.getState().addTab(undefined, window.fleet.homeDir);
    }, 0);
  }, [newWsName]);

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
      {/* Drag region + workspace label with add button */}
      <div
        className="px-3 pt-8 pb-3 flex items-center justify-between"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
          {workspace.label}
        </span>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* Dirty state indicator */}
          {isDirty && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" title="Unsaved changes" />
          )}
          {/* Add tab button */}
          <button
            className="text-neutral-500 hover:text-white text-lg leading-none px-1 rounded hover:bg-neutral-800 transition-colors"
            onClick={() => addTab(undefined, window.fleet.homeDir)}
            title="New Tab (Ctrl+T)"
          >
            +
          </button>
        </div>
      </div>

      {/* Tab list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {workspace.tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            id={tab.id}
            label={tab.label}
            isActive={tab.id === activeTabId}
            badge={getTabBadge(collectPaneIds(tab.splitRoot))}
            index={index}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            isDragOver={
              dropTarget?.index === index
                ? dropTarget.position
                : null
            }
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

      {/* Bottom section: workspaces */}
      <div className="border-t border-neutral-800 px-2 py-2 space-y-0.5">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
            Workspaces
          </span>
          <button
            className="text-neutral-500 hover:text-white text-sm leading-none px-1 rounded hover:bg-neutral-800 transition-colors"
            onClick={() => { setShowNewWsInput(true); setNewWsName(''); }}
            title="New Workspace"
          >
            +
          </button>
        </div>

        {/* Inline new workspace name input */}
        {showNewWsInput && (
          <div className="px-1">
            <input
              ref={newWsInputRef}
              type="text"
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewWorkspace();
                if (e.key === 'Escape') { setShowNewWsInput(false); setNewWsName(''); }
              }}
              onBlur={() => commitNewWorkspace()}
              placeholder="Workspace name..."
              className="w-full px-2 py-1 text-sm bg-neutral-800 text-white border border-neutral-600 rounded focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}

        {/* Saved workspaces list */}
        {savedWorkspaces
          .filter((ws) => ws.id !== workspace.id)
          .map((ws) => (
            <div key={ws.id} className="relative">
              {switchConfirmId === ws.id ? (
                <div className="flex flex-col gap-1 px-2 py-2 bg-neutral-800 rounded-md text-xs">
                  <span className="text-neutral-300">
                    Switch? All terminals will close.
                  </span>
                  <div className="flex gap-2">
                    <button
                      className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                      onClick={() => doSwitchWorkspace(ws.id)}
                    >
                      Yes
                    </button>
                    <button
                      className="px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 rounded transition-colors"
                      onClick={() => setSwitchConfirmId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md transition-colors"
                  onClick={() => handleSwitchWorkspace(ws.id)}
                  title={`Switch to ${ws.label}`}
                >
                  <span className="truncate">{ws.label}</span>
                  <span className="text-xs text-neutral-500 hover:text-blue-400 ml-1 flex-shrink-0">
                    Open
                  </span>
                </button>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
