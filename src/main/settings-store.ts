import Store from 'electron-store';
import type { FleetSettings, FleetSettingsPatch } from '../shared/types';
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
      general: {
        ...DEFAULT_SETTINGS.general,
        ...saved.general,
        terminalBackground: {
          ...DEFAULT_SETTINGS.general.terminalBackground,
          ...saved.general?.terminalBackground
        }
      },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...saved.notifications },
      socketApi: { ...DEFAULT_SETTINGS.socketApi, ...saved.socketApi },
      visualizer: {
        ...DEFAULT_SETTINGS.visualizer,
        ...saved.visualizer,
        effects: { ...DEFAULT_SETTINGS.visualizer.effects, ...saved.visualizer?.effects }
      },
      copilot: { ...DEFAULT_SETTINGS.copilot, ...saved.copilot },
      annotate: { ...DEFAULT_SETTINGS.annotate, ...(saved.annotate ?? {}) },
      kanban: {
        ...DEFAULT_SETTINGS.kanban,
        ...saved.kanban,
        dispatcher: { ...DEFAULT_SETTINGS.kanban.dispatcher, ...saved.kanban?.dispatcher },
        defaults: { ...DEFAULT_SETTINGS.kanban.defaults, ...saved.kanban?.defaults },
        notifications: {
          ...DEFAULT_SETTINGS.kanban.notifications,
          ...saved.kanban?.notifications
        },
        profiles: (saved.kanban?.profiles ?? DEFAULT_SETTINGS.kanban.profiles).map((p) => ({
          ...p,
          role: p.role ?? 'worker'
        }))
      }
    };
  }

  set(partial: FleetSettingsPatch): void {
    const current = this.get();
    const merged = {
      ...current,
      ...partial,
      general: { ...current.general, ...(partial.general ?? {}) },
      notifications: { ...current.notifications, ...(partial.notifications ?? {}) },
      socketApi: { ...current.socketApi, ...(partial.socketApi ?? {}) },
      visualizer: {
        ...current.visualizer,
        ...(partial.visualizer ?? {}),
        effects: { ...current.visualizer.effects, ...(partial.visualizer?.effects ?? {}) }
      },
      copilot: { ...current.copilot, ...(partial.copilot ?? {}) },
      annotate: { ...current.annotate, ...(partial.annotate ?? {}) },
      kanban: {
        ...current.kanban,
        ...(partial.kanban ?? {}),
        dispatcher: { ...current.kanban.dispatcher, ...(partial.kanban?.dispatcher ?? {}) },
        defaults: { ...current.kanban.defaults, ...(partial.kanban?.defaults ?? {}) },
        notifications: {
          ...current.kanban.notifications,
          ...(partial.kanban?.notifications ?? {})
        },
        profiles: partial.kanban?.profiles ?? current.kanban.profiles
      }
    };
    this.store.set('settings', merged);
  }
}
