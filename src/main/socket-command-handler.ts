import { randomUUID } from 'crypto';
import type { SocketCommand, SocketResponse, SocketCommandHandler } from './socket-api';
import type { PtyManager } from './pty-manager';
import type { LayoutStore } from './layout-store';
import type { EventBus } from './event-bus';
import type { NotificationStateManager } from './notification-state';
import type { Workspace, Tab, PaneLeaf, PaneNode, PaneSplit } from '../shared/types';
import type { BrowserWindow } from 'electron';

export class FleetCommandHandler implements SocketCommandHandler {
  private workspace: Workspace = { id: 'default', label: 'Default', tabs: [] };
  private tabs = new Map<string, Tab>();

  private getWindow: (() => BrowserWindow | null) | null = null;

  constructor(
    private ptyManager: PtyManager,
    private layoutStore: LayoutStore,
    private eventBus: EventBus,
    private notificationState: NotificationStateManager
  ) {}

  setWindowGetter(getter: () => BrowserWindow | null): void {
    this.getWindow = getter;
  }

  async handleCommand(cmd: SocketCommand): Promise<SocketResponse> {
    switch (cmd.type) {
      case 'list-workspaces':
        return { ok: true, workspaces: this.layoutStore.list() };

      case 'load-workspace': {
        if (typeof cmd.workspaceId !== 'string')
          return { ok: false, error: 'workspaceId required' };
        const ws = this.layoutStore.load(cmd.workspaceId);
        if (!ws) return { ok: false, error: `workspace not found: ${cmd.workspaceId}` };
        this.workspace = ws;
        this.eventBus.emit('workspace-loaded', { type: 'workspace-loaded', workspaceId: ws.id });
        return { ok: true };
      }

      case 'list-tabs':
        return {
          ok: true,
          tabs: this.workspace.tabs.map((t) => ({
            id: t.id,
            label: t.label,
            cwd: t.cwd
          }))
        };

      case 'new-tab': {
        const paneId = randomUUID();
        const tabId = randomUUID();
        const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : '/';
        const label = typeof cmd.label === 'string' ? cmd.label : 'Shell';

        const leaf: PaneLeaf = { type: 'leaf', id: paneId, cwd };
        const tab: Tab = { id: tabId, label, labelIsCustom: false, cwd, splitRoot: leaf };

        this.workspace.tabs.push(tab);
        this.tabs.set(tabId, tab);

        // Create PTY
        const ptyResult = this.ptyManager.create({
          paneId,
          cwd,
          cmd: typeof cmd.cmd === 'string' ? cmd.cmd : undefined
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId });

        return { ok: true, tabId, paneId, pid: ptyResult.pid };
      }

      case 'close-tab': {
        if (typeof cmd.tabId !== 'string') return { ok: false, error: 'tabId required' };
        const tabId = cmd.tabId;
        const tabIndex = this.workspace.tabs.findIndex((t) => t.id === tabId);
        if (tabIndex === -1) return { ok: false, error: `tab not found: ${tabId}` };

        const tab = this.workspace.tabs[tabIndex];
        const paneIds = this.collectPaneIds(tab.splitRoot);
        for (const pid of paneIds) {
          this.ptyManager.kill(pid);
          this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId: pid });
        }
        this.workspace.tabs.splice(tabIndex, 1);
        this.tabs.delete(tabId);
        return { ok: true };
      }

      case 'list-panes': {
        if (typeof cmd.tabId !== 'string') return { ok: false, error: 'tabId required' };
        const tabId = cmd.tabId;
        const tab = this.workspace.tabs.find((t) => t.id === tabId);
        if (!tab) return { ok: false, error: `tab not found: ${tabId}` };

        const leaves = this.collectPaneLeaves(tab.splitRoot);
        return {
          ok: true,
          panes: leaves.map((leaf) => ({
            id: leaf.id,
            cwd: leaf.cwd,
            shell: leaf.shell,
            hasProcess: this.ptyManager.has(leaf.id)
          }))
        };
      }

      case 'new-pane': {
        if (typeof cmd.paneId !== 'string') return { ok: false, error: 'paneId required' };
        const parentPaneId = cmd.paneId;
        if (!this.ptyManager.has(parentPaneId)) {
          return { ok: false, error: `pane not found: ${parentPaneId}` };
        }

        const newPaneId = randomUUID();
        const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : '/';
        const direction: 'horizontal' | 'vertical' =
          cmd.direction === 'vertical' ? 'vertical' : 'horizontal';

        // Insert new split node into the tab's split tree
        const newLeaf: PaneLeaf = { type: 'leaf', id: newPaneId, cwd };
        for (const tab of this.workspace.tabs) {
          if (this.insertSplit(tab, 'splitRoot', tab.splitRoot, parentPaneId, newLeaf, direction)) {
            break;
          }
        }

        this.ptyManager.create({
          paneId: newPaneId,
          cwd,
          cmd: typeof cmd.cmd === 'string' ? cmd.cmd : undefined
        });

        this.eventBus.emit('pane-created', { type: 'pane-created', paneId: newPaneId });

        return { ok: true, paneId: newPaneId };
      }

      case 'close-pane': {
        if (typeof cmd.paneId !== 'string') return { ok: false, error: 'paneId required' };
        const paneId = cmd.paneId;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.kill(paneId);
        this.eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
        return { ok: true };
      }

      case 'focus-pane': {
        if (typeof cmd.paneId !== 'string') return { ok: false, error: 'paneId required' };
        const paneId = cmd.paneId;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        // Send focus command to renderer
        const win = this.getWindow?.();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send('fleet:focus-pane', { paneId });
        }
        return { ok: true };
      }

      case 'send-input': {
        if (typeof cmd.paneId !== 'string') return { ok: false, error: 'paneId required' };
        if (typeof cmd.data !== 'string') return { ok: false, error: 'data required' };
        const paneId = cmd.paneId;
        if (!this.ptyManager.has(paneId)) {
          return { ok: false, error: `pane not found: ${paneId}` };
        }
        this.ptyManager.write(paneId, cmd.data);
        return { ok: true };
      }

      case 'get-output': {
        return {
          ok: false,
          error: 'get-output requires renderer IPC round-trip — not yet implemented'
        };
      }

      case 'get-state':
        return {
          ok: true,
          workspace: {
            id: this.workspace.id,
            label: this.workspace.label,
            tabCount: this.workspace.tabs.length
          },
          panes: this.ptyManager.paneIds(),
          notifications: this.notificationState.getAllStates()
        };

      default:
        return { ok: false, error: `Unknown command: ${cmd.type}` };
    }
  }

  private collectPaneIds(node: PaneNode): string[] {
    if (node.type === 'leaf') return [node.id];
    return [...this.collectPaneIds(node.children[0]), ...this.collectPaneIds(node.children[1])];
  }

  private collectPaneLeaves(node: PaneNode): PaneLeaf[] {
    if (node.type === 'leaf') return [node];
    return [
      ...this.collectPaneLeaves(node.children[0]),
      ...this.collectPaneLeaves(node.children[1])
    ];
  }

  private insertSplit(
    tab: Tab,
    _key: string,
    node: PaneNode,
    targetPaneId: string,
    newLeaf: PaneLeaf,
    direction: 'horizontal' | 'vertical'
  ): boolean {
    if (node.type === 'leaf' && node.id === targetPaneId) {
      const splitNode: PaneSplit = {
        type: 'split',
        direction,
        ratio: 0.5,
        children: [node, newLeaf]
      };
      tab.splitRoot = this.replaceNode(tab.splitRoot, targetPaneId, splitNode);
      return true;
    }
    if (node.type === 'split') {
      return (
        this.insertSplit(tab, 'left', node.children[0], targetPaneId, newLeaf, direction) ||
        this.insertSplit(tab, 'right', node.children[1], targetPaneId, newLeaf, direction)
      );
    }
    return false;
  }

  private replaceNode(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
    if (node.type === 'leaf') {
      return node.id === targetId ? replacement : node;
    }
    return {
      ...node,
      children: [
        this.replaceNode(node.children[0], targetId, replacement),
        this.replaceNode(node.children[1], targetId, replacement)
      ]
    };
  }
}
