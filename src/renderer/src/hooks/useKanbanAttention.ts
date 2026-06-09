import { useEffect } from 'react';
import { kanbanNotifyChannel } from '../../../shared/kanban-notifications';
import { useKanbanStore } from '../store/kanban-store';
import { useSettingsStore } from '../store/settings-store';
import { useWorkspaceStore } from '../store/workspace-store';

function isKanbanTabActive(): boolean {
  const ws = useWorkspaceStore.getState();
  const active = ws.workspace.tabs.find((t) => t.id === ws.activeTabId);
  return active?.type === 'kanban';
}

/** Wires kanban events to the unread badge + handles notification deep-links. Mount once. */
export function useKanbanAttention(): void {
  // 1: badge bump on events
  useEffect(() => {
    const off = window.fleet.kanban.onEvent((event) => {
      const settings = useSettingsStore.getState().settings;
      if (!settings) return;
      if (!kanbanNotifyChannel(event.kind, settings.kanban.notifications, 'badge')) return;
      if (isKanbanTabActive()) return;
      useKanbanStore.getState().incrementUnread();
    });
    return off;
  }, []);

  // 2: clear unread whenever the active tab becomes a kanban tab
  useEffect(() => {
    let prevActive = useWorkspaceStore.getState().activeTabId;
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (state.activeTabId === prevActive) return;
      prevActive = state.activeTabId;
      const active = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (active?.type === 'kanban') useKanbanStore.getState().markSeen();
    });
    return unsub;
  }, []);

  // 3: deep-link from a clicked OS notification
  useEffect(() => {
    const off = window.fleet.kanban.onKanbanFocusTask(({ boardSlug, taskId }) => {
      const ws = useWorkspaceStore.getState();
      ws.setToolVisible('kanban', true);
      const existing = useWorkspaceStore.getState().workspace.tabs.find((t) => t.type === 'kanban');
      if (existing) ws.setActiveTab(existing.id);
      const kanban = useKanbanStore.getState();
      const applyBoard =
        kanban.activeBoardSlug !== boardSlug ? kanban.switchBoard(boardSlug) : Promise.resolve();
      void applyBoard.then(() => {
        if (taskId) void useKanbanStore.getState().openTask(taskId);
      });
    });
    return off;
  }, []);
}
