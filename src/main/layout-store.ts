import Store from 'electron-store';
import type { Workspace } from '../shared/types';

type StoreSchema = {
  workspaces: Record<string, Workspace>;
};

export class LayoutStore {
  private store: Store<StoreSchema>;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'fleet-layouts',
      defaults: {
        workspaces: {},
      },
    });
  }

  save(workspace: Workspace): void {
    const workspaces = this.store.get('workspaces', {});
    workspaces[workspace.id] = workspace;
    this.store.set('workspaces', workspaces);
  }

  load(workspaceId: string): Workspace | undefined {
    const workspaces = this.store.get('workspaces', {});
    return workspaces[workspaceId];
  }

  list(): Workspace[] {
    const workspaces = this.store.get('workspaces', {});
    return Object.values(workspaces);
  }

  delete(workspaceId: string): void {
    const workspaces = this.store.get('workspaces', {});
    delete workspaces[workspaceId];
    this.store.set('workspaces', workspaces);
  }
}
