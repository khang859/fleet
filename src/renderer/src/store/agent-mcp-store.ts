import { create } from 'zustand';
import type {
  McpDetectedServer,
  McpServerConfig,
  McpServersConfig,
  McpServerStatus,
  McpSnapshot
} from '../../../shared/agent-mcp';
import { createLogger } from '../logger';

const log = createLogger('store:agent-mcp');

/**
 * The Agent pane's MCP servers, as the settings pane sees them.
 *
 * Kept apart from `agent-store` because it is a different kind of state: that
 * store is per pane and per turn, this one is a single app-wide list that
 * changes when the user edits it or when a connection comes and goes. Sharing a
 * store would mean every transcript keystroke re-rendering the settings pane.
 *
 * Main owns the truth. Every call here answers with the whole snapshot, so the
 * pane never has to ask a second time what its own click did, and cannot end up
 * drawing a saved config beside a status from before it was saved.
 */
type AgentMcpState = {
  servers: McpServersConfig;
  statuses: McpServerStatus[];
  /** Which servers have a credential stored. Never what it is. */
  credentials: Record<string, boolean>;
  /** What other tools have configured, from the last scan. */
  detected: McpDetectedServer[];
  /** False until the first read lands, so the pane can tell empty from not-yet. */
  loaded: boolean;
  scanning: boolean;
  /** Servers with a call in flight, so their row can say so. */
  busy: Record<string, boolean | undefined>;
  /**
   * Why a sign-in did not happen, per server.
   *
   * Deliberately not folded into the status's `error`: that one describes a
   * connection, and a sign-in the user abandoned never got as far as one.
   */
  signInErrors: Record<string, string | undefined>;

  load: () => Promise<void>;
  /** Add a server, or replace one under the name it already has. */
  put: (name: string, config: McpServerConfig) => Promise<void>;
  /** Replace a server and its name in one write, so a rename is not a delete. */
  rename: (from: string, to: string, config: McpServerConfig) => Promise<void>;
  remove: (name: string) => Promise<void>;
  reconnect: (name: string) => Promise<void>;
  signIn: (name: string) => Promise<void>;
  signOut: (name: string) => Promise<void>;
  setToken: (name: string, token: string | null) => Promise<void>;
  scan: (cwd: string) => Promise<void>;
  importPicked: (picked: Array<{ name: string; path: string }>, cwd: string) => Promise<void>;
};

export const useAgentMcpStore = create<AgentMcpState>((set, get) => {
  const apply = (snap: McpSnapshot): void => {
    set({
      servers: snap.servers,
      statuses: snap.statuses,
      credentials: snap.credentials,
      loaded: true
    });
  };

  /** Run a call that belongs to one server, with its row marked while it runs. */
  const forServer = async (name: string, call: Promise<McpSnapshot>): Promise<void> => {
    set((s) => ({ busy: { ...s.busy, [name]: true } }));
    try {
      apply(await call);
    } finally {
      set((s) => ({ busy: { ...s.busy, [name]: undefined } }));
    }
  };

  return {
    servers: {},
    statuses: [],
    credentials: {},
    detected: [],
    loaded: false,
    scanning: false,
    busy: {},
    signInErrors: {},

    load: async () => {
      apply(await window.fleet.agent.mcp.get());
    },

    put: async (name, config) => {
      apply(await window.fleet.agent.mcp.set({ ...get().servers, [name]: config }));
    },

    rename: async (from, to, config) => {
      const next = { ...get().servers };
      delete next[from];
      // In one write, because main forgets the credentials of a server that is
      // no longer in the list - a rename done as a delete and an add would take
      // the user's token with it.
      apply(await window.fleet.agent.mcp.set({ ...next, [to]: config }));
    },

    remove: async (name) => {
      const next = { ...get().servers };
      delete next[name];
      apply(await window.fleet.agent.mcp.set(next));
    },

    reconnect: async (name) => {
      await forServer(name, window.fleet.agent.mcp.reconnect(name));
    },

    signIn: async (name) => {
      // Cleared first: the last attempt's message sitting under a spinner reads
      // as though this one had already failed.
      set((s) => ({ signInErrors: { ...s.signInErrors, [name]: undefined } }));
      try {
        await forServer(name, window.fleet.agent.mcp.signIn(name));
      } catch (err) {
        // Expected rather than exceptional: a browser tab closed, a consent
        // screen declined, or five minutes of nothing.
        const message = err instanceof Error ? err.message : String(err);
        log.warn('sign-in failed', { name, message });
        set((s) => ({ signInErrors: { ...s.signInErrors, [name]: message } }));
      }
    },

    signOut: async (name) => {
      set((s) => ({ signInErrors: { ...s.signInErrors, [name]: undefined } }));
      await forServer(name, window.fleet.agent.mcp.signOut(name));
    },

    setToken: async (name, token) => {
      await forServer(name, window.fleet.agent.mcp.setToken(name, token));
    },

    scan: async (cwd) => {
      set({ scanning: true });
      try {
        set({ detected: await window.fleet.agent.mcp.detect(cwd) });
      } finally {
        set({ scanning: false });
      }
    },

    importPicked: async (picked, cwd) => {
      apply(await window.fleet.agent.mcp.import(picked, cwd));
      // The rows just imported are no longer new, and the only way to know that
      // is to ask again.
      await get().scan(cwd);
    }
  };
});

/** The status of one server, for a row that has its config but not its state. */
export function statusOf(statuses: McpServerStatus[], name: string): McpServerStatus | undefined {
  return statuses.find((s) => s.name === name);
}

/** How many servers have something the user has not imported yet. */
export function newlyFound(detected: McpDetectedServer[]): number {
  return detected.filter((d) => d.status !== 'known').length;
}

// Pushed whenever a connection changes state, including with nobody asking -
// a server that dropped mid-turn, or one that finished its handshake.
window.fleet.agent.mcp.onStatus((statuses) => {
  useAgentMcpStore.setState({ statuses });
});
