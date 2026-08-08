import { create } from 'zustand';
import type {
  FoundSkill,
  InstalledSkill,
  SkillFetchResult,
  SkillInstallOutcome
} from '../../../shared/agent-skill-install';
import { createLogger } from '../logger';

const log = createLogger('store:agent-skills');

/**
 * The skills Fleet holds, as the settings pane sees them.
 *
 * Split from `agent-store` for the same reason the MCP store is: this is one
 * app-wide list that changes only when the user changes it, and folding it into
 * the per-pane store would make every transcript keystroke re-render it.
 *
 * Simpler than the MCP store, because a skill is a folder rather than a
 * connection. Nothing here has a state to watch - there is no equivalent of a
 * server dropping - so every call ends by re-reading the list from main rather
 * than by patching a copy the renderer keeps.
 */
type AgentSkillsState = {
  installed: InstalledSkill[];
  /** False until the first read lands, so the pane can tell empty from not-yet. */
  loaded: boolean;

  /** What other tools already have on disk, from the last scan. */
  detected: FoundSkill[];
  scanning: boolean;

  /**
   * The clone the fetch dialog is looking at, if there is one.
   *
   * Held here rather than in the dialog because it owns a temporary directory in
   * main: leaving the dialog has to discard it, and a value that only exists
   * while a component is mounted is the wrong place to keep something that needs
   * cleaning up.
   */
  fetched: SkillFetchResult | null;
  fetching: boolean;
  /** Why the last clone did not happen. Cleared when another is started. */
  fetchError: string | null;

  /** Names that could not be installed, from the last run. */
  installErrors: Array<{ name: string; reason: string }>;

  load: () => Promise<void>;
  scan: (cwd: string) => Promise<void>;
  fetch: (from: string) => Promise<void>;
  /** Throw away the checkout, whether it was installed from or abandoned. */
  discard: () => Promise<void>;
  install: (picked: Array<{ name: string; path: string }>, cwd: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
};

export const useAgentSkillsStore = create<AgentSkillsState>((set, get) => ({
  installed: [],
  loaded: false,
  detected: [],
  scanning: false,
  fetched: null,
  fetching: false,
  fetchError: null,
  installErrors: [],

  load: async () => {
    set({ installed: await window.fleet.agent.skills.list(), loaded: true });
  },

  scan: async (cwd) => {
    set({ scanning: true });
    try {
      set({ detected: await window.fleet.agent.skills.detect(cwd) });
    } finally {
      set({ scanning: false });
    }
  },

  fetch: async (from) => {
    // The previous checkout goes before the next one is asked for, so a user
    // trying three repositories in a row leaves one temporary directory behind
    // rather than three.
    await get().discard();
    set({ fetching: true, fetchError: null });
    try {
      set({ fetched: await window.fleet.agent.skills.fetch(from) });
    } catch (err) {
      // Ordinary rather than exceptional: a typo, a private repository, no
      // network, or a repository that simply has no skills in it.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('fetch failed', { from, message });
      set({ fetchError: cleanIpcError(message) });
    } finally {
      set({ fetching: false });
    }
  },

  discard: async () => {
    const { fetched } = get();
    if (fetched === null) return;
    set({ fetched: null, fetchError: null });
    await window.fleet.agent.skills.discard(fetched.fetchId);
  },

  install: async (picked, cwd) => {
    const outcome: SkillInstallOutcome = await window.fleet.agent.skills.install(picked, cwd);
    set({ installErrors: outcome.failed });
    await get().load();
    // The rows just installed are no longer new, and asking again is the only
    // way to know that.
    await get().scan(cwd);
  },

  remove: async (name) => {
    await window.fleet.agent.skills.remove(name);
    await get().load();
  },

  reveal: async (path) => {
    await window.fleet.agent.skills.reveal(path);
  }
}));

/** How many of the found skills are worth importing. */
export function newlyFound(detected: FoundSkill[]): number {
  return detected.filter((d) => d.status !== 'known').length;
}

/**
 * Everything not already held, which is what a user opening either dialog wants.
 *
 * Both dialogs start from this: the common case is "yes, all of them", and a
 * user who wants three of eight unticks five faster than they tick three.
 */
export function defaultPicks(found: FoundSkill[]): Set<string> {
  return new Set(found.filter((f) => f.status !== 'known').map((f) => f.origin.path));
}

/**
 * The sentence inside an IPC rejection.
 *
 * Electron prefixes what main threw with its own channel plumbing, and "Error
 * invoking remote method 'agent:skills:fetch':" in front of the message is noise
 * to everyone who is not debugging Electron.
 */
function cleanIpcError(message: string): string {
  const marker = message.lastIndexOf('Error: ');
  return marker === -1 ? message : message.slice(marker + 'Error: '.length);
}
