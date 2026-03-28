import Store from 'electron-store';
import { randomUUID } from 'crypto';
import type { Workspace, Tab } from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('layout:persistence');

type StoreSchema = {
  workspaces: Record<string, Workspace>;
};

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
    workspaces[workspace.id] = workspace;
    this.store.set('workspaces', workspaces);
  }

  load(workspaceId: string): Workspace | undefined {
    const workspaces = this.store.get('workspaces', {});
    const ws = workspaces[workspaceId];
    log.debug('load', { workspaceId, found: !!ws, tabCount: ws?.tabs.length });
    return ws;
  }

  list(): Workspace[] {
    const workspaces = this.store.get('workspaces', {});
    return Object.values(workspaces);
  }

  delete(workspaceId: string): void {
    log.debug('delete', { workspaceId });
    const workspaces = this.store.get('workspaces', {});
    delete workspaces[workspaceId];
    this.store.set('workspaces', workspaces);
  }

  ensureImagesTab(workspaceId: string, cwd: string): void {
    const workspace = this.load(workspaceId);
    if (!workspace) return;

    const hasImages = workspace.tabs.some((t) => t.type === 'images');
    if (hasImages) return;

    const paneId = randomUUID();
    const imagesTab: Tab = {
      id: randomUUID(),
      label: 'Images',
      labelIsCustom: true,
      cwd,
      type: 'images',
      splitRoot: { type: 'leaf', id: paneId, cwd }
    };

    workspace.tabs.unshift(imagesTab);
    this.save(workspace);
  }
}
