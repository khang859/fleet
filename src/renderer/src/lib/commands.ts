import { ALL_SHORTCUTS, formatShortcut, type ShortcutDef } from './shortcuts';
import { joinPath } from './shell-utils';
import { useWorkspaceStore } from '../store/workspace-store';
import { useVisualizerStore } from '../store/visualizer-store';

export type Command = {
  id: string;
  label: string;
  shortcut?: ShortcutDef;
  category: string;
  execute: () => void;
};

function sc(id: string): ShortcutDef | undefined {
  return ALL_SHORTCUTS.find((s) => s.id === id);
}

export function createCommandRegistry(): Command[] {
  return [
    {
      id: 'new-tab',
      label: 'New Tab',
      shortcut: sc('new-tab'),
      category: 'Tabs',
      execute: () => useWorkspaceStore.getState().addTab(undefined, window.fleet.homeDir)
    },
    {
      id: 'close-pane',
      label: 'Close Pane',
      shortcut: sc('close-pane'),
      category: 'Panes',
      execute: () => {
        const { activePaneId, closePane } = useWorkspaceStore.getState();
        if (activePaneId) closePane(activePaneId);
      }
    },
    {
      id: 'split-right',
      label: 'Split Right',
      shortcut: sc('split-right'),
      category: 'Panes',
      execute: () => {
        const { activePaneId, splitPane } = useWorkspaceStore.getState();
        if (activePaneId) splitPane(activePaneId, 'horizontal');
      }
    },
    {
      id: 'split-down',
      label: 'Split Down',
      shortcut: sc('split-down'),
      category: 'Panes',
      execute: () => {
        const { activePaneId, splitPane } = useWorkspaceStore.getState();
        if (activePaneId) splitPane(activePaneId, 'vertical');
      }
    },
    {
      id: 'search',
      label: 'Search in Pane',
      shortcut: sc('search'),
      category: 'Panes',
      execute: () => {
        const { activePaneId } = useWorkspaceStore.getState();
        document.dispatchEvent(
          new CustomEvent('fleet:toggle-search', { detail: { paneId: activePaneId } })
        );
      }
    },
    {
      id: 'toggle-visualizer',
      label: 'Toggle Visualizer',
      shortcut: sc('visualizer'),
      category: 'View',
      execute: () => useVisualizerStore.getState().toggleVisible()
    },
    {
      id: 'settings',
      label: 'Open Settings',
      shortcut: sc('settings'),
      category: 'App',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))
    },
    {
      id: 'shortcuts',
      label: 'Show Shortcuts',
      shortcut: sc('shortcuts'),
      category: 'App',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'))
    },
    {
      id: 'rename-tab',
      label: 'Rename Tab',
      shortcut: sc('rename-tab'),
      category: 'Tabs',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:rename-active-tab'))
    },
    {
      id: 'git-changes',
      label: 'Git Changes',
      shortcut: sc('git-changes'),
      category: 'View',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))
    },
    {
      id: 'open-file',
      label: 'Open File...',
      shortcut: sc('open-file'),
      category: 'File',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:open-file-dialog'))
    },
    {
      id: 'quick-open',
      label: 'Quick Open',
      shortcut: sc('quick-open'),
      category: 'File',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-quick-open'))
    },
    {
      id: 'file-search',
      label: 'Search Files on Disk',
      shortcut: sc('file-search'),
      category: 'File',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'))
    },
    {
      id: 'clipboard-history',
      label: 'Clipboard History',
      shortcut: sc('clipboard-history'),
      category: 'Edit',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'))
    },
    {
      id: 'inject-skills',
      label: 'Inject Fleet Skills',
      shortcut: sc('inject-skills'),
      category: 'Agent',
      execute: () => {
        const { activePaneId } = useWorkspaceStore.getState();
        if (activePaneId) {
          window.fleet.pty.input({
            paneId: activePaneId,
            data: `Read ${joinPath(window.fleet.homeDir, '.fleet', 'skills', 'fleet.md')} to learn the Fleet terminal commands available to you.\n`
          });
        }
      }
    }
  ];
}

export function fuzzyMatch(query: string, label: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  let qi = 0;
  for (let li = 0; li < l.length && qi < q.length; li++) {
    if (l[li] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function formatCommandShortcut(cmd: Command): string | undefined {
  return cmd.shortcut ? formatShortcut(cmd.shortcut) : undefined;
}
