import Store from 'electron-store';
import type { FleetSettings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

export class SettingsStore {
  private store: Store<{ settings: FleetSettings }>;

  constructor() {
    this.store = new Store<{ settings: FleetSettings }>({
      name: 'fleet-settings',
      defaults: {
        settings: DEFAULT_SETTINGS
      }
    });
  }

  get(): FleetSettings {
    const saved = this.store.get('settings');
    // Deep-merge with defaults to handle new fields added after initial save
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      general: { ...DEFAULT_SETTINGS.general, ...saved.general },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...saved.notifications },
      socketApi: { ...DEFAULT_SETTINGS.socketApi, ...saved.socketApi },
      visualizer: {
        ...DEFAULT_SETTINGS.visualizer,
        ...saved.visualizer,
        effects: { ...DEFAULT_SETTINGS.visualizer.effects, ...(saved.visualizer?.effects ?? {}) }
      }
    };
  }

  set(partial: Partial<FleetSettings>): void {
    const current = this.get();
    const merged = {
      ...current,
      ...partial,
      general: { ...current.general, ...(partial.general ?? {}) },
      notifications: { ...current.notifications, ...(partial.notifications ?? {}) },
      socketApi: { ...current.socketApi, ...(partial.socketApi ?? {}) },
      visualizer: { ...current.visualizer, ...(partial.visualizer ?? {}) }
    };
    this.store.set('settings', merged);
  }
}
