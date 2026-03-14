import Store from 'electron-store';
import type { FleetSettings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

export class SettingsStore {
  private store: Store<{ settings: FleetSettings }>;

  constructor() {
    this.store = new Store<{ settings: FleetSettings }>({
      name: 'fleet-settings',
      defaults: {
        settings: DEFAULT_SETTINGS,
      },
    });
  }

  get(): FleetSettings {
    return this.store.get('settings');
  }

  set(partial: Partial<FleetSettings>): void {
    const current = this.get();
    const merged = {
      ...current,
      ...partial,
      general: { ...current.general, ...(partial.general ?? {}) },
      notifications: { ...current.notifications, ...(partial.notifications ?? {}) },
      socketApi: { ...current.socketApi, ...(partial.socketApi ?? {}) },
      visualizer: { ...current.visualizer, ...(partial.visualizer ?? {}) },
    };
    this.store.set('settings', merged);
  }
}
