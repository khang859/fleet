import { create } from 'zustand';
import type { AgentCatalog, AgentMessage, AgentUsage } from '../../../shared/agent-types';
import {
  canCompact,
  contextUsed,
  estimateTranscriptTokens,
  shouldCompact,
  splitForCompaction
} from '../../../shared/agent-context';
import { useSettingsStore } from './settings-store';
import { createLogger } from '../logger';

const log = createLogger('store:agent');

/** One pane's transcript. In memory only - it dies with the pane, by design. */
type PaneThread = {
  messages: AgentMessage[];
  /** The folder the pane works in, remembered so compaction can run unprompted. */
  cwd: string;
  /** Set while a turn or a compaction is in flight; the id main tags its events with. */
  streamId: string | null;
  /**
   * Set while the in-flight work is a compaction rather than a reply, holding
   * the tail that will survive it. Captured when the compaction starts, not
   * recomputed when it finishes: the summary must replace exactly what was sent
   * to be summarized, whatever else has happened since.
   */
  pendingCompact: { keep: AgentMessage[] } | null;
  /**
   * When the in-flight work started, for the elapsed clock. Kept here rather
   * than in the component so switching to the Settings tab and back shows how
   * long the turn has really been running.
   */
  startedAt: number | null;
  error: string | null;
  /**
   * Roughly what the next turn will resend, from the provider's own count where
   * there is one. `null` until the first turn reports, which is also why
   * nothing may treat a missing figure as zero.
   */
  contextTokens: number | null;
};

const EMPTY_THREAD: PaneThread = {
  messages: [],
  cwd: '',
  streamId: null,
  pendingCompact: null,
  startedAt: null,
  error: null,
  contextTokens: null
};

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
  /** Folds the older half of the transcript into a summary. Ignored while busy. */
  compact: (paneId: string) => void;
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
        [paneId]: {
          ...thread,
          cwd,
          messages: [...thread.messages, user, assistant],
          streamId,
          startedAt: Date.now(),
          error: null
        }
      }
    });
    window.fleet.agent.send({ streamId, cwd, history: thread.messages, text });
  },

  compact: (paneId) => {
    const thread = get().threads[paneId];
    if (thread?.streamId !== null) return;

    const { older, recent } = splitForCompaction(thread.messages);
    // Nothing to gain, and summarizing a lone summary is how a compaction loop
    // starts. The same check gates the automatic path.
    if (!canCompact(thread.messages)) return;

    const streamId = crypto.randomUUID();
    set({
      threads: {
        ...get().threads,
        [paneId]: {
          ...thread,
          streamId,
          pendingCompact: { keep: recent },
          startedAt: Date.now(),
          error: null
        }
      }
    });
    log.debug('compact', { paneId, older: older.length, keep: recent.length });
    window.fleet.agent.compact({ streamId, cwd: thread.cwd, messages: older });
  },

  cancel: (paneId) => {
    const streamId = get().threads[paneId]?.streamId;
    if (streamId) window.fleet.agent.cancel(streamId);
  },

  clearThread: (paneId) => {
    get().cancel(paneId);
    const cwd = get().threads[paneId]?.cwd ?? '';
    set({ threads: { ...get().threads, [paneId]: { ...EMPTY_THREAD, cwd } } });
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

function endTurn(streamId: string, error: string | null, usage: AgentUsage | null): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const { paneId, thread } = found;
  // A compaction that ended here rather than on its own channel was cancelled
  // or failed, so the transcript is untouched and so is what we know about it.
  const wasCompacting = thread.pendingCompact !== null;

  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [paneId]: {
        ...thread,
        streamId: null,
        pendingCompact: null,
        startedAt: null,
        error,
        contextTokens: wasCompacting
          ? thread.contextTokens
          : contextUsed(usage, estimateTranscriptTokens(thread.messages))
      }
    }
  }));

  // Only a completed turn can trigger compaction. A failed one leaves the
  // transcript where it was, and a compaction triggering another compaction is
  // the loop this feature has to not have.
  if (error === null && !wasCompacting) autoCompact(paneId);
}

/**
 * Compact unprompted when the transcript has grown past the user's threshold.
 *
 * This runs after a turn rather than before the next one so the work happens
 * while the pane is idle: pressing send should not buy a summarization first,
 * and there is no half-typed message to lose.
 */
function autoCompact(paneId: string): void {
  const state = useAgentStore.getState();
  const thread = state.threads[paneId];
  const agent = useSettingsStore.getState().settings?.ai.agent;
  if (!thread || !agent) return;

  const model = state.catalog?.models.find((m) => m.id === agent.coding.model);
  const limit = model?.contextLimit ?? null;
  if (!shouldCompact(thread.contextTokens ?? 0, limit, agent.compactThreshold)) return;
  if (!canCompact(thread.messages)) return;

  log.debug('auto-compact', { paneId, used: thread.contextTokens, limit });
  state.compact(paneId);
}

function applySummary(streamId: string, summary: string): void {
  const found = threadOf(streamId);
  const pending = found?.thread.pendingCompact;
  // No compaction in flight under this id: a summary from a pane that has
  // already moved on, which must not be allowed to rewrite the transcript.
  if (!found || !pending) return;

  const message: AgentMessage = {
    id: crypto.randomUUID(),
    role: 'summary',
    content: summary,
    reasoning: ''
  };
  const messages = [message, ...pending.keep];

  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [found.paneId]: {
        ...found.thread,
        messages,
        streamId: null,
        pendingCompact: null,
        startedAt: null,
        error: null,
        // The provider's count for the summarizing call describes that call,
        // not this transcript, so the new size is estimated until a real turn
        // reports on it.
        contextTokens: estimateTranscriptTokens(messages)
      }
    }
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
window.fleet.agent.onStreamDone(({ streamId, usage }) => endTurn(streamId, null, usage));
window.fleet.agent.onStreamError(({ streamId, message }) => {
  log.warn('stream error', { message });
  endTurn(streamId, message, null);
});
window.fleet.agent.onCompactDone(({ streamId, summary }) => applySummary(streamId, summary));
