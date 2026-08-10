import Store from 'electron-store';
import type { CopilotWorkspaceOverride, FleetSettings, FleetSettingsPatch } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

/**
 * Rebuild the per-workspace copilot overrides from disk, key by key.
 *
 * The saved map is keyed by workspace id, so its entries can be anything - including a
 * key present with no value, which a plain spread would carry through as an "override"
 * that overrides nothing.
 */
function readWorkspaceOverrides(
  saved: Record<string, CopilotWorkspaceOverride | undefined> | undefined
): Record<string, CopilotWorkspaceOverride> {
  const overrides: Record<string, CopilotWorkspaceOverride> = {};
  for (const [workspaceId, override] of Object.entries(saved ?? {})) {
    if (override) overrides[workspaceId] = { claudeConfigDir: override.claudeConfigDir };
  }
  return overrides;
}

export class SettingsStore {
  /**
   * Typed as a *patch*, not as `FleetSettings`, because that is what is actually on disk:
   * a file written by an older version predates every setting added since, so any subtree
   * can be missing. Claiming the read is a complete `FleetSettings` would make the
   * defaulting in `get()` look redundant to both the compiler and the reader, right up
   * until an upgrade hands us a file without one of these keys.
   */
  private store: Store<{ settings: FleetSettingsPatch }>;
  /**
   * The last merged answer, held until something changes it.
   *
   * `electron-store` reads the file, parses it and validates it against its
   * schema on every single access - there is no in-memory copy underneath. That
   * is invisible for a setting read when a dialog opens, and expensive for the
   * ones read on a hot path: the agent's permission gate asks for the rules
   * before every command it runs and again for every MCP call, so a turn that
   * runs a few hundred tools was doing a few hundred blocking reads of the same
   * unchanged file on the process that also serves terminal keystrokes.
   *
   * `watch` is what keeps this honest rather than merely fast. It invalidates
   * on any write to the file, including one from outside this process, so the
   * cache cannot go stale the way a plain memo would - and on macOS it is an
   * `fs.watch` on the directory with a 100ms debounce, not a poll.
   */
  private cached: FleetSettings | null = null;

  constructor() {
    this.store = new Store<{ settings: FleetSettingsPatch }>({
      name: 'fleet-settings',
      defaults: {
        settings: DEFAULT_SETTINGS
      },
      watch: true
    });
    this.store.onDidAnyChange(() => {
      this.cached = null;
    });
  }

  get(): FleetSettings {
    if (this.cached !== null) return this.cached;
    const saved = this.store.get('settings');
    // Deep-merge with defaults to handle new fields added after initial save
    this.cached = {
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
      // Merged per channel, not as one spread: a saved `taskComplete` that predates the
      // `os` toggle would otherwise replace the whole default channel and leave `os`
      // undefined, silently turning a notification off.
      notifications: {
        taskComplete: {
          ...DEFAULT_SETTINGS.notifications.taskComplete,
          ...saved.notifications?.taskComplete
        },
        needsPermission: {
          ...DEFAULT_SETTINGS.notifications.needsPermission,
          ...saved.notifications?.needsPermission
        },
        processExitError: {
          ...DEFAULT_SETTINGS.notifications.processExitError,
          ...saved.notifications?.processExitError
        },
        processExitClean: {
          ...DEFAULT_SETTINGS.notifications.processExitClean,
          ...saved.notifications?.processExitClean
        }
      },
      socketApi: { ...DEFAULT_SETTINGS.socketApi, ...saved.socketApi },
      visualizer: {
        ...DEFAULT_SETTINGS.visualizer,
        ...saved.visualizer,
        effects: { ...DEFAULT_SETTINGS.visualizer.effects, ...saved.visualizer?.effects }
      },
      copilot: {
        ...DEFAULT_SETTINGS.copilot,
        ...saved.copilot,
        workspaceOverrides: readWorkspaceOverrides(saved.copilot?.workspaceOverrides)
      },
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
            ...saved.ai?.agent?.permissions,
            // Nested one level deeper than the rest: `mcp` is its own allow/deny pair, so a
            // saved copy holding only `allow` must not drop the default `deny`.
            mcp: {
              ...DEFAULT_SETTINGS.ai.agent.permissions.mcp,
              ...saved.ai?.agent?.permissions?.mcp
            }
          },
          voice: { ...DEFAULT_SETTINGS.ai.agent.voice, ...saved.ai?.agent?.voice }
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
    return this.cached;
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
          },
          voice: { ...current.ai.agent.voice, ...(partial.ai?.agent?.voice ?? {}) }
        }
      },
      remoteSsh: {
        ...current.remoteSsh,
        ...(partial.remoteSsh ?? {}),
        hosts: partial.remoteSsh?.hosts ?? current.remoteSsh.hosts
      }
    };
    // Ahead of the write rather than after it: the watcher that would clear
    // this is debounced, so between the write and the notification a reader
    // would otherwise be handed the settings as they were before this call.
    this.cached = null;
    this.store.set('settings', merged);
  }
}
