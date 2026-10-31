import Store from 'electron-store';
import type { Workspace, PaneNode } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('layout:persistence');

type StoreSchema = {
  workspaces: Record<string, Workspace>;
};

function containsPane(node: PaneNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.id === paneId;
  return containsPane(node.children[0], paneId) || containsPane(node.children[1], paneId);
}

/**
 * Strip one-shot startup commands (e.g. session-resume `cmd`, a worktree's setup
 * `typeOnStart`) from pane leaves before persisting. Otherwise a resumed tab would
 * re-run `claude --resume <id>` on every app restart.
 */
function stripPaneCmds(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    if (node.cmd === undefined && node.typeOnStart === undefined) return node;
    const copy = { ...node };
    delete copy.cmd;
    delete copy.typeOnStart;
    return copy;
  }
  return {
    ...node,
    children: [stripPaneCmds(node.children[0]), stripPaneCmds(node.children[1])]
  };
}

export class LayoutStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'fleet-layouts',
      defaults: {
        workspaces: {}
      }
    });
  }

  save(workspace: Workspace): void {
    log.debug('save', {
      id: workspace.id,
      label: workspace.label,
      tabCount: workspace.tabs.length
    });
    const workspaces = this.store.get('workspaces', {});
    workspaces[workspace.id] = {
      ...workspace,
      tabs: workspace.tabs.map((t) => ({ ...t, splitRoot: stripPaneCmds(t.splitRoot) }))
    };
    this.store.set('workspaces', workspaces);
  }

  load(workspaceId: string): Workspace | undefined {
    // Annotated with `| undefined` values because that is what a lookup by arbitrary id
    // yields; the bare `Record` type claims every id is present.
    const workspaces: Record<string, Workspace | undefined> = this.store.get('workspaces', {});
    const ws = workspaces[workspaceId];
    log.debug('load', { workspaceId, found: !!ws, tabCount: ws?.tabs.length });
    return ws;
  }

  list(): Workspace[] {
    const workspaces = this.store.get('workspaces', {});
    return Object.values(workspaces);
  }

  findWorkspaceForPane(paneId: string): { workspaceId: string; workspaceName: string } | null {
    const workspaces = this.store.get('workspaces', {});
    for (const ws of Object.values(workspaces)) {
      for (const tab of ws.tabs) {
        if (containsPane(tab.splitRoot, paneId)) {
          return { workspaceId: ws.id, workspaceName: ws.label };
        }
      }
    }
    return null;
  }

  /** Removes the job tabs an older Fleet saved. Their panes ended with it. */
  dropJobTabs(): void {
    const workspaces = this.store.get('workspaces', {});
    let dropped = 0;
    for (const ws of Object.values(workspaces)) {
      const tabs = ws.tabs.filter((t) => !('agencyJobId' in t));
      dropped += ws.tabs.length - tabs.length;
      ws.tabs = tabs;
    }
    if (dropped === 0) return;
    log.debug('dropJobTabs', { dropped });
    this.store.set('workspaces', workspaces);
  }

  delete(workspaceId: string): void {
    log.debug('delete', { workspaceId });
    const workspaces = this.store.get('workspaces', {});
    delete workspaces[workspaceId];
    this.store.set('workspaces', workspaces);
  }
}
