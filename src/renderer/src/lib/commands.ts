import { ALL_SHORTCUTS, formatShortcut, type ShortcutDef } from './shortcuts';
import { useWorkspaceStore } from '../store/workspace-store';
import { useToastStore } from '../store/toast-store';
import type { RemoteHost } from '../../../shared/remote-ssh-types';
import type { TeleprompterCommand, TeleprompterSourceRequest } from '../../../shared/teleprompter';

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

const TELEPROMPTER_KEYWORDS = [
  'teleprompter',
  'presenter',
  'speaker',
  'notes',
  'present',
  'slides'
];

/**
 * Run a teleprompter command from the palette, saying so when it could not do
 * what was asked - the overlay is a separate window, so nothing else here
 * would show it.
 */
async function runTeleprompter(command: TeleprompterCommand): Promise<void> {
  const show = useToastStore.getState().show;
  const state = await window.fleet.teleprompter.command(command);
  if (!state.open && command.type !== 'close') {
    show('Open the teleprompter first');
    return;
  }
  // Said when the overlay appears, not on every command after.
  if (command.type === 'toggleVisible' && state.visible && state.hotkeys.some((h) => !h.ok)) {
    show('Some teleprompter shortcuts are unavailable. See Settings > Teleprompter.');
  }
}

async function loadTeleprompterNotes(source: TeleprompterSourceRequest): Promise<void> {
  const result = await window.fleet.teleprompter.setSource(source);
  if (!result.ok) useToastStore.getState().show(result.error);
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
      id: 'open-scratch',
      label: 'New Agent',
      category: 'Agent',
      keywords: ['agent', 'ai', 'assistant', 'code', 'scratch', 'chat', 'quick', 'image', 'ask'],
      // No folder picker: every agent starts as a scratch chat, and the folder
      // label under its composer moves it to a project before the first message.
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
    },
    {
      id: 'teleprompter-toggle',
      label: 'Show / Hide Teleprompter',
      category: 'View',
      keywords: TELEPROMPTER_KEYWORDS,
      execute: () => void runTeleprompter({ type: 'toggleVisible' })
    },
    {
      id: 'teleprompter-open-file',
      label: 'Teleprompter: Open Notes File...',
      category: 'View',
      keywords: TELEPROMPTER_KEYWORDS,
      execute: () => void loadTeleprompterNotes({ kind: 'pick' })
    },
    {
      id: 'teleprompter-paste',
      label: 'Teleprompter: Paste Notes from Clipboard',
      category: 'View',
      keywords: TELEPROMPTER_KEYWORDS,
      execute: () => void loadTeleprompterNotes({ kind: 'clipboard' })
    },
    {
      id: 'teleprompter-toggle-lock',
      label: 'Teleprompter: Lock / Unlock',
      category: 'View',
      keywords: [...TELEPROMPTER_KEYWORDS, 'click through'],
      execute: () => void runTeleprompter({ type: 'toggleLock' })
    },
    {
      id: 'teleprompter-reset-timer',
      label: 'Teleprompter: Reset Timer',
      category: 'View',
      keywords: TELEPROMPTER_KEYWORDS,
      execute: () => void runTeleprompter({ type: 'resetTimer' })
    }
  ];
}

export function fuzzyMatch(query: string, label: string): boolean {
  return fuzzyIndices(query, label) !== null;
}

/**
 * Where each character of `query` was found in `label`, in order, so a list
 * can show why a row matched. `null` when it does not match; empty for an
 * empty query.
 */
export function fuzzyIndices(query: string, label: string): number[] | null {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const found: number[] = [];
  for (let li = 0; li < l.length && found.length < q.length; li++) {
    if (l[li] === q[found.length]) found.push(li);
  }
  return found.length === q.length ? found : null;
}

export function formatCommandShortcut(cmd: Command): string | undefined {
  return cmd.shortcut ? formatShortcut(cmd.shortcut) : undefined;
}
