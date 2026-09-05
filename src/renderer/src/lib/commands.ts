import { ALL_SHORTCUTS, formatShortcut, type ShortcutDef } from './shortcuts';
import { useWorkspaceStore } from '../store/workspace-store';
import { useVisualizerStore } from '../store/visualizer-store';
import { useToastStore } from '../store/toast-store';
import type { RemoteHost } from '../../../shared/remote-ssh-types';

export type Command = {
  id: string;
  label: string;
  shortcut?: ShortcutDef;
  category: string;
  keywords?: string[];
  execute: () => void;
};

function sc(id: string): ShortcutDef | undefined {
  return ALL_SHORTCUTS.find((s) => s.id === id);
}

/**
 * Open a browser on whatever host the active pane is already SSH'd into.
 *
 * The detected destination is used for this pane only and is deliberately not
 * persisted - saving hosts is an explicit act in Settings, so a one-off `ssh`
 * in a terminal never quietly accumulates entries in the user's host list.
 */
async function browseDetectedHost(): Promise<void> {
  const { activePaneId, openSshBrowser } = useWorkspaceStore.getState();
  const show = useToastStore.getState().show;
  if (!activePaneId) return;

  const result = await window.fleet.remoteSsh.detectHost(activePaneId);
  if (!result.success) {
    show(result.error);
    return;
  }
  if (result.data === null) {
    show('This pane is not connected to a remote host over SSH');
    return;
  }
  const detected = result.data;
  openSshBrowser({
    id: crypto.randomUUID(),
    // Saved hosts carry a short human label; a detected one only has a
    // destination, so shorten it the way people say it out loud - the first
    // segment of the hostname, not the full user@fqdn.
    label: detected.host.split('.')[0] || detected.host,
    host: detected.host,
    user: detected.user,
    port: detected.port,
    identityFile: detected.identityFile
  });
}

/** One "Browse <host>" command per saved host, so the palette reaches them directly. */
export function createRemoteHostCommands(hosts: RemoteHost[]): Command[] {
  return hosts.map((host) => ({
    id: `browse-remote:${host.id}`,
    label: `Browse ${host.label}`,
    category: 'File',
    keywords: ['ssh', 'remote', 'sftp', 'server', host.host, host.user ?? ''],
    execute: () => useWorkspaceStore.getState().openSshBrowser(host)
  }));
}

export function createCommandRegistry(): Command[] {
  return [
    {
      id: 'new-tab',
      label: 'New Tab',
      shortcut: sc('new-tab'),
      category: 'Tabs',
      keywords: ['dispatch', 'agent', 'new agent'],
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
      id: 'shell-env',
      label: 'Shell Environment',
      category: 'View',
      keywords: ['env', 'environment', 'variables', 'shell', 'export'],
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-shell-env'))
    },
    {
      id: 'rename-tab',
      label: 'Rename Tab',
      shortcut: sc('rename-tab'),
      category: 'Tabs',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:rename-active-tab'))
    },
    {
      id: 'rename-pane',
      label: 'Rename Pane',
      shortcut: sc('rename-pane'),
      category: 'Panes',
      execute: () => {
        const state = useWorkspaceStore.getState();
        const activeTab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
        if (activeTab?.splitRoot.type === 'split' && state.activePaneId) {
          document.dispatchEvent(
            new CustomEvent('fleet:rename-active-pane', {
              detail: { paneId: state.activePaneId }
            })
          );
        }
      }
    },
    {
      id: 'git-changes',
      label: 'Git Changes',
      shortcut: sc('git-changes'),
      category: 'View',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))
    },
    {
      id: 'browse-remote-here',
      label: 'Browse Files on This Remote Host',
      category: 'File',
      keywords: ['ssh', 'remote', 'sftp', 'server'],
      execute: () => void browseDetectedHost()
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
      id: 'jump-needy-agent',
      label: 'Jump to Agent That Needs Input',
      category: 'Agent',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:jump-needy-agent'))
    },
    {
      id: 'peek-needy-agent',
      label: 'Peek at Agent That Needs Input',
      shortcut: sc('peek-needy-agent'),
      category: 'Agent',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:peek-needy-agent'))
    },
    {
      id: 'agent-overview',
      label: 'Agent Overview',
      shortcut: sc('agent-overview'),
      category: 'Agent',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-agent-overview'))
    },
    {
      id: 'open-agent',
      label: 'New Agent Pane',
      category: 'Agent',
      keywords: ['agent', 'ai', 'assistant', 'code'],
      // The pane needs a folder to work in, so the dialog runs first and opens
      // the pane itself once the user has chosen one.
      execute: () => document.dispatchEvent(new CustomEvent('fleet:new-agent'))
    },
    {
      id: 'open-scratch',
      label: 'Open Scratch Chat',
      category: 'Agent',
      keywords: ['scratch', 'chat', 'quick', 'image', 'generate', 'ask'],
      // No folder to pick: that is the whole point of it, and the store both
      // reveals the tool and lands the user in the tab.
      execute: () => useWorkspaceStore.getState().openScratch()
    },
    {
      id: 'open-sessions',
      label: 'Open Sessions',
      category: 'Tabs',
      execute: () => {
        const ws = useWorkspaceStore.getState();
        ws.setToolVisible('sessions', true);
        const sessions = useWorkspaceStore
          .getState()
          .workspace.tabs.find((t) => t.type === 'sessions');
        if (sessions) ws.setActiveTab(sessions.id);
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
