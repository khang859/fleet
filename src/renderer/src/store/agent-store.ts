import { create } from 'zustand';
import type { AgentCatalog, AgentMessage } from '../../../shared/agent-types';
import { createLogger } from '../logger';

const log = createLogger('store:agent');

/** One pane's transcript. In memory only - it dies with the pane, by design. */
type PaneThread = {
  messages: AgentMessage[];
  /** Set while a turn is streaming; the id main tags its events with. */
  streamId: string | null;
  error: string | null;
};

const EMPTY_THREAD: PaneThread = { messages: [], streamId: null, error: null };

/**
 * State backing the agent panes. The settings themselves live in the app
 * settings store under `ai.agent`; what is agent-specific is the models.dev
 * catalog, the OpenRouter key (the same key Chat stores), and the transcripts.
 */
type AgentStoreState = {
  catalog: AgentCatalog | null;
  loadingModels: boolean;
  keyPresent: boolean;
  /** Keyed by pane id, so switching to the Settings tab does not lose a thread. */
  threads: Record<string, PaneThread | undefined>;
  /** Loads the catalog once per session; `refresh` re-downloads it. */
  loadModels: (refresh?: boolean) => Promise<void>;
  loadKey: () => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
  send: (paneId: string, cwd: string, text: string) => void;
  cancel: (paneId: string) => void;
  clearThread: (paneId: string) => void;
};

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  catalog: null,
  loadingModels: false,
  keyPresent: false,
  threads: {},

  loadModels: async (refresh = false) => {
    if (get().loadingModels) return;
    if (get().catalog && !refresh) return;
    set({ loadingModels: true });
    try {
      const catalog = await window.fleet.agent.listModels(refresh);
      log.debug('loadModels', { count: catalog.models.length, source: catalog.source });
      set({ catalog });
    } finally {
      set({ loadingModels: false });
    }
  },

  loadKey: async () => {
    set({ keyPresent: await window.fleet.chat.hasKey() });
  },

  saveKey: async (key) => {
    await window.fleet.chat.setKey(key);
    set({ keyPresent: true });
  },

  clearKey: async () => {
    await window.fleet.chat.clearKey();
    set({ keyPresent: false });
  },

  send: (paneId, cwd, text) => {
    const thread = get().threads[paneId] ?? EMPTY_THREAD;
    if (thread.streamId !== null) return;

    const streamId = crypto.randomUUID();
    const user: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      reasoning: ''
    };
    const assistant: AgentMessage = {
      id: streamId,
      role: 'assistant',
      content: '',
      reasoning: ''
    };
    // The placeholder goes in before the request leaves, so the first delta
    // always has somewhere to land.
    set({
      threads: {
        ...get().threads,
        [paneId]: { messages: [...thread.messages, user, assistant], streamId, error: null }
      }
    });
    window.fleet.agent.send({ streamId, cwd, history: thread.messages, text });
  },

  cancel: (paneId) => {
    const streamId = get().threads[paneId]?.streamId;
    if (streamId) window.fleet.agent.cancel(streamId);
  },

  clearThread: (paneId) => {
    get().cancel(paneId);
    set({ threads: { ...get().threads, [paneId]: EMPTY_THREAD } });
  }
}));

/** The pane whose turn `streamId` belongs to, or null once the turn has ended. */
function threadOf(streamId: string): { paneId: string; thread: PaneThread } | null {
  for (const [paneId, thread] of Object.entries(useAgentStore.getState().threads)) {
    if (thread?.streamId === streamId) return { paneId, thread };
  }
  return null;
}

/** Append to the streaming assistant message, which carries the stream's id. */
function appendToAssistant(streamId: string, field: 'content' | 'reasoning', delta: string): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const messages = found.thread.messages.map((m) =>
    m.id === streamId ? { ...m, [field]: m[field] + delta } : m
  );
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, messages } }
  }));
}

function endTurn(streamId: string, error: string | null): void {
  const found = threadOf(streamId);
  if (found === null) return;
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, streamId: null, error } }
  }));
}

// Installed once: there is a single main→renderer channel per event, and every
// event carries the id of the turn that produced it.
window.fleet.agent.onStreamChunk(({ streamId, delta }) =>
  appendToAssistant(streamId, 'content', delta)
);
window.fleet.agent.onStreamReasoning(({ streamId, delta }) =>
  appendToAssistant(streamId, 'reasoning', delta)
);
window.fleet.agent.onStreamDone(({ streamId }) => endTurn(streamId, null));
window.fleet.agent.onStreamError(({ streamId, message }) => {
  log.warn('stream error', { message });
  endTurn(streamId, message);
});
