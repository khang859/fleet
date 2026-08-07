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
          ...saved.general?.terminalBackground,
          slideshow: {
            ...DEFAULT_SETTINGS.general.terminalBackground.slideshow,
            ...saved.general?.terminalBackground?.slideshow
          }
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
      // `tools` and `ai` are rebuilt key by key rather than spread from `saved`,
      // so a tool or capability that no longer exists (kanban, images, chat)
      // drops out on the next write instead of riding along forever.
      tools: {
        annotate: saved.tools?.annotate ?? DEFAULT_SETTINGS.tools.annotate,
        sessions: saved.tools?.sessions ?? DEFAULT_SETTINGS.tools.sessions
      },
      ai: {
        agent: {
          ...DEFAULT_SETTINGS.ai.agent,
          ...saved.ai?.agent,
          coding: { ...DEFAULT_SETTINGS.ai.agent.coding, ...saved.ai?.agent?.coding },
          image: { ...DEFAULT_SETTINGS.ai.agent.image, ...saved.ai?.agent?.image },
          permissions: {
            ...DEFAULT_SETTINGS.ai.agent.permissions,
            ...saved.ai?.agent?.permissions
          }
        }
      },
      remoteSsh: {
        ...DEFAULT_SETTINGS.remoteSsh,
        ...saved.remoteSsh,
        // Whole-array replace - a saved host list is
        // authoritative, not something to merge element-wise with defaults.
        hosts: saved.remoteSsh?.hosts ?? DEFAULT_SETTINGS.remoteSsh.hosts
      }
    };
  }

  set(partial: FleetSettingsPatch): void {
    const current = this.get();
    const merged = {
      ...current,
      ...partial,
      general: {
        ...current.general,
        ...(partial.general ?? {}),
        terminalBackground: {
          ...current.general.terminalBackground,
          ...(partial.general?.terminalBackground ?? {}),
          slideshow: {
            ...current.general.terminalBackground.slideshow,
            ...(partial.general?.terminalBackground?.slideshow ?? {})
          }
        }
      },
      notifications: { ...current.notifications, ...(partial.notifications ?? {}) },
      socketApi: { ...current.socketApi, ...(partial.socketApi ?? {}) },
      visualizer: {
        ...current.visualizer,
        ...(partial.visualizer ?? {}),
        effects: { ...current.visualizer.effects, ...(partial.visualizer?.effects ?? {}) }
      },
      copilot: { ...current.copilot, ...(partial.copilot ?? {}) },
      annotate: { ...current.annotate, ...(partial.annotate ?? {}) },
      tools: { ...current.tools, ...(partial.tools ?? {}) },
      ai: {
        ...current.ai,
        ...(partial.ai ?? {}),
        agent: {
          ...current.ai.agent,
          ...(partial.ai?.agent ?? {}),
          coding: { ...current.ai.agent.coding, ...(partial.ai?.agent?.coding ?? {}) },
          image: { ...current.ai.agent.image, ...(partial.ai?.agent?.image ?? {}) },
          permissions: {
            ...current.ai.agent.permissions,
            ...(partial.ai?.agent?.permissions ?? {})
          }
        }
      },
      remoteSsh: {
        ...current.remoteSsh,
        ...(partial.remoteSsh ?? {}),
        hosts: partial.remoteSsh?.hosts ?? current.remoteSsh.hosts
      }
    };
    this.store.set('settings', merged);
  }
}
