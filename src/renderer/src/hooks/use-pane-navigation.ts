import { useEffect } from 'react';
import { useWorkspaceStore, collectPaneIds } from '../store/workspace-store';
import { ALL_SHORTCUTS, matchesShortcut, type ShortcutDef } from '../lib/shortcuts';

function sc(id: string): ShortcutDef {
  const def = ALL_SHORTCUTS.find((s) => s.id === id);
  // Every id below is a literal that exists in ALL_SHORTCUTS. A miss means a shortcut was
  // renamed without updating this file, and a binding that silently never fires is far
  // harder to notice than a thrown error.
  if (!def) throw new Error(`Unknown shortcut id: ${id}`);
  return def;
}

/** Filter out pinned tools for Cmd+1-9 tab switching. */
export function getNormalTabs<T extends { type?: string; cwd: string }>(tabs: T[]): T[] {
  return tabs.filter(
    (t) => t.type !== 'settings' && t.type !== 'annotate' && t.type !== 'sessions'
  );
}

/**
 * The id one row above or below `tabId` in `rowIds`, or undefined at either end
 * of the list - the arrows stop there rather than wrap.
 */
export function neighbourTabId(
  rowIds: Array<string | null>,
  tabId: string,
  step: 1 | -1
): string | undefined {
  const index = rowIds.indexOf(tabId);
  if (index === -1) return undefined;
  return rowIds[index + step] ?? undefined;
}

/**
 * Tab ids in the order the sidebar drew them. Read off the rendered rows,
 * because only the sidebar knows that order - groups, nested files and
 * collapsed sections all move a tab away from its place in `workspace.tabs`.
 */
function sidebarRowIds(): Array<string | null> {
  return Array.from(document.querySelectorAll('[data-tab-id]'), (el) =>
    el.getAttribute('data-tab-id')
  );
}

/**
 * Which way a bare Up/Down walks the sidebar, or null for any other key. Only
 * an image or media tab acts on it: neither has a caret or scroll position for
 * the arrows to move, where a terminal or an editor needs them for itself.
 */
function sidebarArrowStep(e: KeyboardEvent): 1 | -1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return null;
  if (e.key === 'ArrowDown') return 1;
  if (e.key === 'ArrowUp') return -1;
  return null;
}

export function usePaneNavigation(): void {
  /*
   * Read on demand, never subscribe. This hook runs inside `App`, so a bare
   * `useWorkspaceStore()` re-renders every pane in every tab on any workspace
   * change (#541) and re-binds the listener each time. A keydown handler only
   * ever needs the state as it stands at the keypress, which `getState()` gives
   * for free - so the listener binds once and the hook renders never.
   */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented) return;
      const state = useWorkspaceStore.getState();
      const { workspace, activeTabId, activePaneId, addTab, closePane, splitPane, setActiveTab } =
        state;

      const sidebarStep = sidebarArrowStep(e);
      const tabType = workspace.tabs.find((t) => t.id === activeTabId)?.type;
      if (sidebarStep && activeTabId && (tabType === 'image' || tabType === 'media')) {
        e.preventDefault();
        const next = neighbourTabId(sidebarRowIds(), activeTabId, sidebarStep);
        if (next) setActiveTab(next);
        return;
      }

      // Shift+F2 to rename active pane
      if (matchesShortcut(e, sc('rename-pane'))) {
        e.preventDefault();
        const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
        // Only fire when there are 2+ panes (header is visible)
        if (activeTab?.splitRoot.type === 'split' && activePaneId) {
          document.dispatchEvent(
            new CustomEvent('fleet:rename-active-pane', {
              detail: { paneId: activePaneId }
            })
          );
        }
        return;
      }

      // F2 to rename active tab
      if (matchesShortcut(e, sc('rename-tab'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:rename-active-tab'));
        return;
      }

      if (matchesShortcut(e, sc('new-tab'))) {
        e.preventDefault();
        addTab(undefined, window.fleet.homeDir);
        return;
      }

      if (matchesShortcut(e, sc('close-pane'))) {
        e.preventDefault();
        if (activePaneId) closePane(activePaneId);
        return;
      }

      // Split down must be checked before split right (superset modifiers)
      if (matchesShortcut(e, sc('split-down'))) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'vertical');
        return;
      }

      if (matchesShortcut(e, sc('split-right'))) {
        e.preventDefault();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
        return;
      }

      // Navigate panes
      if (matchesShortcut(e, sc('navigate-prev')) || matchesShortcut(e, sc('navigate-next'))) {
        e.preventDefault();
        const activeTab = workspace.tabs.find((t) => t.id === activeTabId);
        if (!activeTab) return;
        const tabPaneIds = collectPaneIds(activeTab.splitRoot);
        const currentIndex = activePaneId ? tabPaneIds.indexOf(activePaneId) : -1;
        const forward = matchesShortcut(e, sc('navigate-next'));
        const nextIndex = forward
          ? (currentIndex + 1) % tabPaneIds.length
          : (currentIndex - 1 + tabPaneIds.length) % tabPaneIds.length;
        if (tabPaneIds[nextIndex]) {
          state.setActivePane(tabPaneIds[nextIndex]);
        }
        return;
      }

      // Cycle tabs
      if (matchesShortcut(e, sc('cycle-tab-next')) || matchesShortcut(e, sc('cycle-tab-prev'))) {
        e.preventDefault();
        const tabIndex = workspace.tabs.findIndex((t) => t.id === activeTabId);
        const forward = matchesShortcut(e, sc('cycle-tab-next'));
        const nextIndex = forward
          ? (tabIndex + 1) % workspace.tabs.length
          : (tabIndex - 1 + workspace.tabs.length) % workspace.tabs.length;
        if (workspace.tabs[nextIndex]) setActiveTab(workspace.tabs[nextIndex].id);
        return;
      }

      if (matchesShortcut(e, sc('search'))) {
        e.preventDefault();
        document.dispatchEvent(
          new CustomEvent('fleet:toggle-search', { detail: { paneId: activePaneId } })
        );
        return;
      }

      if (matchesShortcut(e, sc('settings'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-settings'));
        return;
      }

      if (matchesShortcut(e, sc('shortcuts'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'));
        return;
      }

      if (matchesShortcut(e, sc('command-palette'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-command-palette'));
        return;
      }

      if (matchesShortcut(e, sc('git-changes'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'));
        return;
      }

      if (matchesShortcut(e, sc('open-file'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:open-file-dialog'));
        return;
      }

      if (matchesShortcut(e, sc('quick-open'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-quick-open'));
        return;
      }

      if (matchesShortcut(e, sc('file-search'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'));
        return;
      }

      if (matchesShortcut(e, sc('clipboard-history'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'));
        return;
      }

      if (matchesShortcut(e, sc('telescope'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-telescope'));
        return;
      }

      if (matchesShortcut(e, sc('open-scratch'))) {
        e.preventDefault();
        useWorkspaceStore.getState().openScratch();
        return;
      }

      if (matchesShortcut(e, sc('agent-overview'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-agent-overview'));
        return;
      }

      if (matchesShortcut(e, sc('peek-needy-agent'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:peek-needy-agent'));
        return;
      }

      // Cmd/Ctrl+1-9 to switch tabs (check metaKey on mac, ctrlKey on other)
      // Only count normal tabs — special tabs (Sessions, Settings) are excluded
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const modHeld = isMac ? e.metaKey : e.ctrlKey;
      if (modHeld && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        const normalTabs = getNormalTabs(workspace.tabs);
        const tab = normalTabs.at(index);
        if (tab) setActiveTab(tab.id);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
