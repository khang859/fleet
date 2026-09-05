import Store from 'electron-store';
import type { CopilotWorkspaceOverride, FleetSettings, FleetSettingsPatch } from '../shared/types';
import { DEFAULT_SCROLLBACK } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/constants';

/**
 * Read the per-host answer to Fleet's "install the shell snippet?" offer.
 *
 * Written narrowly rather than spread: the saved copy is a deep-partial, so its
 * values are optional, and this is also the point where a hand-edited settings
 * file with a value Fleet does not recognise gets dropped instead of stored.
 */
function readRcConsent(
  saved: Record<string, unknown> | undefined
): Record<string, 'installed' | 'declined'> {
  const out: Record<string, 'installed' | 'declined'> = {};
  for (const [key, value] of Object.entries(saved ?? {})) {
    if (value === 'installed' || value === 'declined') out[key] = value;
  }
  return out;
}

/**
 * The scrollback default from before the setting was wired up to xterm at all.
 *
 * `electron-store` writes `defaults` straight into the file, so this landed on
 * disk for every user even though no terminal ever read it - they all ran on
 * xterm's 3000-line fallback. Honouring the saved 10,000 now that the setting
 * works would triple per-pane memory for a value nobody chose, so the one
 * migration below rewrites exactly that number and leaves any other alone.
 */
const LEGACY_DEFAULT_SCROLLBACK = 10_000;

/**
 * Split out of the migration below so it can be tested directly: the mock the
 * settings tests run against stands in for `electron-store` and does not
 * implement `migrations`, which would otherwise leave the one transform that
 * rewrites persisted user data as the only untested thing in this file.
 */
export function migrateLegacyScrollback(saved: FleetSettingsPatch): FleetSettingsPatch {
  if (saved.general?.scrollbackSize !== LEGACY_DEFAULT_SCROLLBACK) return saved;
  return { ...saved, general: { ...saved.general, scrollbackSize: DEFAULT_SCROLLBACK } };
}

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
  private backing: Store<{ settings: FleetSettingsPatch }> | null = null;
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

  /**
   * Opened on first access rather than in the constructor.
   *
   * `conf`, underneath `electron-store`, writes its file atomically as part of
   * construction - a blocking `fsync` on the main process, and Fleet builds one
   * of these before the window exists. Nothing about opening a window needs a
   * setting, so the file work waits until the renderer asks for one.
   */
  private get store(): Store<{ settings: FleetSettingsPatch }> {
    if (this.backing !== null) return this.backing;
    const store = new Store<{ settings: FleetSettingsPatch }>({
      name: 'fleet-settings',
      defaults: {
        settings: DEFAULT_SETTINGS
      },
      // Keyed at the version in package.json when this shipped rather than at a
      // future one: conf runs a migration when its key is <= the running app
      // version, so a key that is ahead of the current build would sit dormant
      // through local testing and through any patch release before it.
      migrations: {
        '2.106.0': (store) => {
          const saved = store.get('settings');
          const migrated = migrateLegacyScrollback(saved);
          // Returned unchanged for everyone who never had the old default, and
          // writing it back anyway would cost them the blocking atomic write
          // that the lazy `store` getter above exists to avoid.
          if (migrated !== saved) store.set('settings', migrated);
        }
      },
      watch: true
    });
    store.onDidAnyChange(() => {
      this.cached = null;
    });
    this.backing = store;
    return store;
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
        sessions: saved.tools?.sessions ?? DEFAULT_SETTINGS.tools.sessions,
        scratch: saved.tools?.scratch ?? DEFAULT_SETTINGS.tools.scratch
      },
      ai: {
        agent: {
          ...DEFAULT_SETTINGS.ai.agent,
          ...saved.ai?.agent,
          coding: { ...DEFAULT_SETTINGS.ai.agent.coding, ...saved.ai?.agent?.coding },
          image: { ...DEFAULT_SETTINGS.ai.agent.image, ...saved.ai?.agent?.image },
          webFetch: { ...DEFAULT_SETTINGS.ai.agent.webFetch, ...saved.ai?.agent?.webFetch },
          webSearch: { ...DEFAULT_SETTINGS.ai.agent.webSearch, ...saved.ai?.agent?.webSearch },
          advisor: { ...DEFAULT_SETTINGS.ai.agent.advisor, ...saved.ai?.agent?.advisor },
          fusion: { ...DEFAULT_SETTINGS.ai.agent.fusion, ...saved.ai?.agent?.fusion },
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
        hosts: saved.remoteSsh?.hosts ?? DEFAULT_SETTINGS.remoteSsh.hosts,
        rcConsent: readRcConsent(saved.remoteSsh?.rcConsent)
      }
    };
    return this.cached;
  }

  /**
   * Set or clear one workspace's config-folder override, leaving every other
   * entry alone.
   *
   * `set` merges `copilot` one level deep, so the whole overrides map is
   * replaced wholesale by whatever a patch carries. A renderer that wanted to
   * change one workspace therefore had to send back a map it read earlier, and
   * any entry written in between - by another window, or by workspace creation
   * running beside a settings edit - was dropped. Reading the current map here,
   * in the process that owns the file, closes that window.
   *
   * An empty or whitespace-only folder removes the override rather than storing
   * an assignment that assigns nothing.
   */
  /**
   * Point one workspace at its own Claude config folder, and say whether that
   * was a change.
   *
   * The comparison belongs here rather than in the renderer: a renderer holds a
   * copy of the settings that is stale for as long as any write is in flight,
   * so a renderer-side "this is already saved" check can skip a write that was
   * genuinely needed and leave the file disagreeing with the screen. This
   * process owns the file, so its answer cannot be out of date.
   */
  setWorkspaceOverride(workspaceId: string, claudeConfigDir: string | null): boolean {
    const overrides = { ...this.get().copilot.workspaceOverrides };
    const dir = claudeConfigDir?.trim();
    const before = overrides[workspaceId]?.claudeConfigDir ?? null;
    if ((dir ?? null) === before) return false;
    if (dir) overrides[workspaceId] = { claudeConfigDir: dir };
    else delete overrides[workspaceId];
    this.set({ copilot: { workspaceOverrides: overrides } });
    return true;
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
          webFetch: { ...current.ai.agent.webFetch, ...(partial.ai?.agent?.webFetch ?? {}) },
          webSearch: { ...current.ai.agent.webSearch, ...(partial.ai?.agent?.webSearch ?? {}) },
          advisor: { ...current.ai.agent.advisor, ...(partial.ai?.agent?.advisor ?? {}) },
          fusion: { ...current.ai.agent.fusion, ...(partial.ai?.agent?.fusion ?? {}) },
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
        hosts: partial.remoteSsh?.hosts ?? current.remoteSsh.hosts,
        rcConsent: partial.remoteSsh?.rcConsent
          ? readRcConsent(partial.remoteSsh.rcConsent)
          : current.remoteSsh.rcConsent
      }
    };
    // Ahead of the write rather than after it: the watcher that would clear
    // this is debounced, so between the write and the notification a reader
    // would otherwise be handed the settings as they were before this call.
    this.cached = null;
    this.store.set('settings', merged);
  }
}
