import { create } from 'zustand';
import type { AgentCatalog, AgentMessage, AgentUsage } from '../../../shared/agent-types';
import { messageText, textMessage } from '../../../shared/agent-types';
import type { AgentToolCall } from '../../../shared/agent-tools';
import type { AgentSessionEvent } from '../../../shared/agent-session';
import {
  canCompact,
  contextUsed,
  estimateTranscriptTokens,
  shouldCompact,
  splitForCompaction
} from '../../../shared/agent-context';
import { useSettingsStore } from './settings-store';
import { useWorkspaceStore } from './workspace-store';
import { draftInto } from '../hooks/use-terminal';
import { createLogger } from '../logger';

const log = createLogger('store:agent');

/**
 * One pane's transcript. The live copy is here; the durable one is the pane's
 * session log, which this store appends to as the transcript changes and reads
 * back when the pane opens.
 */
type PaneThread = {
  messages: AgentMessage[];
  /** The folder the pane works in, remembered so compaction can run unprompted. */
  cwd: string;
  /**
   * The session file this thread is written to. `null` before the pane has
   * told the store which one it is, which is the only state in which nothing
   * is recorded - a turn is never written to a file we cannot name.
   */
  sessionId: string | null;
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
  sessionId: null,
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
  /**
   * Adopt a pane's session: replay whatever it left on disk into the thread.
   * Called when the pane mounts, and safe to call again - a thread that has
   * already been opened is left alone rather than reloaded over the top of a
   * live conversation.
   */
  openSession: (paneId: string, sessionId: string, cwd: string) => Promise<void>;
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

  openSession: async (paneId, sessionId, cwd) => {
    // Already adopted: the pane remounts on every layout change, and reloading
    // here would drop a live conversation on the floor.
    if (get().threads[paneId]) return;
    // Claimed before the read, not after, so a turn started in the meantime is
    // recorded against the right session rather than going unwritten.
    set({ threads: { ...get().threads, [paneId]: { ...EMPTY_THREAD, sessionId, cwd } } });

    const replay = await window.fleet.agent.loadSession(sessionId);
    log.debug('openSession', { paneId, sessionId, messages: replay.messages.length });
    const thread = get().threads[paneId];
    if (!thread) return;
    set({
      threads: {
        ...get().threads,
        [paneId]: {
          ...thread,
          // Prepended rather than assigned: anything already here was said
          // while the file was being read, so it belongs after the history.
          messages: [...replay.messages, ...thread.messages],
          contextTokens: thread.contextTokens ?? replay.contextTokens
        }
      }
    });
  },

  send: (paneId, cwd, text) => {
    const thread = get().threads[paneId] ?? EMPTY_THREAD;
    if (thread.streamId !== null) return;

    const streamId = crypto.randomUUID();
    const user = textMessage(crypto.randomUUID(), 'user', text);
    const assistant: AgentMessage = {
      id: streamId,
      role: 'assistant',
      parts: [],
      reasoning: '',
      reasoningMs: null
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
    // Written before the request leaves: what the user said is worth keeping
    // whether or not the turn that follows ever comes back.
    record(thread, { t: 'message', message: user });
    // The session is the conversation, so it is what tools remember against.
    // Before one exists there is nothing older than this turn to remember, and
    // the stream id says exactly that.
    window.fleet.agent.send({
      streamId,
      threadId: thread.sessionId ?? streamId,
      cwd,
      history: thread.messages,
      text
    });
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

/**
 * Write one event to the thread's session log.
 *
 * A thread with no session id records nothing: that only happens to a thread
 * this store made up on the spot (a `send` for a pane that never announced
 * itself), and inventing a file for it would scatter orphan sessions on disk.
 */
function record(thread: PaneThread, event: AgentSessionEvent): void {
  if (thread.sessionId === null) return;
  window.fleet.agent.appendSession({
    sessionId: thread.sessionId,
    cwd: thread.cwd,
    event
  });
}

/** The pane whose turn `streamId` belongs to, or null once the turn has ended. */
function threadOf(streamId: string): { paneId: string; thread: PaneThread } | null {
  for (const [paneId, thread] of Object.entries(useAgentStore.getState().threads)) {
    if (thread?.streamId === streamId) return { paneId, thread };
  }
  return null;
}

/**
 * Append answer text to the streaming assistant message.
 *
 * Onto the last part when that is text, as a new part when it is a call: text
 * written after a tool ran is a separate paragraph of the turn, and joining it
 * to what was written before the call is exactly the ordering this avoids.
 */
function appendText(streamId: string, delta: string): void {
  updateStreaming(streamId, (m, startedAt) => {
    const last = m.parts.at(-1);
    const parts =
      last?.type === 'text'
        ? [...m.parts.slice(0, -1), { type: 'text' as const, text: last.text + delta }]
        : [...m.parts, { type: 'text' as const, text: delta }];
    // The first answer token ends the thinking. Measured from the send rather
    // than from the first reasoning token, so the number the block settles on
    // is the one the live clock was showing the moment it settled.
    const stamp = m.reasoningMs === null && m.reasoning !== '' && messageText(m) === '';
    return {
      ...m,
      parts,
      ...(stamp && startedAt !== null ? { reasoningMs: Date.now() - startedAt } : {})
    };
  });
}

function appendReasoning(streamId: string, delta: string): void {
  updateStreaming(streamId, (m) => ({ ...m, reasoning: m.reasoning + delta }));
}

/** Rewrite the message this stream is writing into, leaving the rest alone. */
function updateStreaming(
  streamId: string,
  change: (message: AgentMessage, startedAt: number | null) => AgentMessage
): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const messages = found.thread.messages.map((m) =>
    m.id === streamId ? change(m, found.thread.startedAt) : m
  );
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, messages } }
  }));
}

/**
 * Put a tool call on the assistant message this turn is writing, or replace it
 * when the same call comes back finished.
 *
 * Matched by the call's own id rather than by position: the pane shows the
 * calls in the order the model asked for them, and an end event that arrived
 * late must land on its own row rather than append a second one.
 */
function recordToolCall(streamId: string, call: AgentToolCall): void {
  updateStreaming(streamId, (m) => {
    const at = m.parts.findIndex((p) => p.type === 'tool' && p.call.id === call.id);
    const parts =
      at === -1
        ? [...m.parts, { type: 'tool' as const, call }]
        : m.parts.map((p, i) => (i === at ? { type: 'tool' as const, call } : p));
    return { ...m, parts };
  });
}

/**
 * Put a command the agent cannot run in front of the user.
 *
 * Main knows the turn and the renderer knows the panes, so the two halves meet
 * here: the turn says which agent pane asked, the workspace says which terminal
 * is beside it, and the command is typed there for the user to run.
 */
function handOff(streamId: string, command: string): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const paneId = useWorkspaceStore.getState().terminalBeside(found.paneId);
  if (paneId === null) return;
  log.debug('handOff', { paneId, command });
  draftInto(paneId, command);
}

function endTurn(streamId: string, error: string | null, usage: AgentUsage | null): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const { paneId, thread } = found;
  // A compaction that ended here rather than on its own channel was cancelled
  // or failed, so the transcript is untouched and so is what we know about it.
  const wasCompacting = thread.pendingCompact !== null;
  const contextTokens = wasCompacting
    ? thread.contextTokens
    : contextUsed(usage, estimateTranscriptTokens(thread.messages));

  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [paneId]: {
        ...thread,
        streamId: null,
        pendingCompact: null,
        startedAt: null,
        error,
        contextTokens
      }
    }
  }));

  // The reply is only written down once it has stopped changing. A turn that
  // was cancelled or failed part-way is recorded as far as it got, since that
  // is what the transcript shows and what the next turn will send; one that
  // produced nothing at all leaves no trace.
  if (!wasCompacting) {
    const reply = thread.messages.find((m) => m.id === streamId);
    // A turn that only looked at things and then failed still leaves what it
    // looked at behind, since that is what the pane shows.
    if (reply && (reply.parts.length > 0 || reply.reasoning !== '')) {
      record(thread, { t: 'message', message: reply });
    }
    if (contextTokens !== null) record(thread, { t: 'context', tokens: contextTokens });
  }

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

  const message = textMessage(crypto.randomUUID(), 'summary', summary);
  const messages = [message, ...pending.keep];
  const contextTokens = estimateTranscriptTokens(messages);

  // One line saying what replaced what, rather than a rewrite: the turns the
  // summary folded up stay in the file, and replay reaches the same transcript
  // the pane is showing.
  record(found.thread, { t: 'compact', summary: message, keep: pending.keep.map((m) => m.id) });
  record(found.thread, { t: 'context', tokens: contextTokens });

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
        contextTokens
      }
    }
  }));
}

// Installed once: there is a single main→renderer channel per event, and every
// event carries the id of the turn that produced it.
window.fleet.agent.onStreamChunk(({ streamId, delta }) => appendText(streamId, delta));
window.fleet.agent.onStreamReasoning(({ streamId, delta }) => appendReasoning(streamId, delta));
window.fleet.agent.onStreamDone(({ streamId, usage }) => endTurn(streamId, null, usage));
window.fleet.agent.onStreamError(({ streamId, message }) => {
  log.warn('stream error', { message });
  endTurn(streamId, message, null);
});
window.fleet.agent.onHandOff(({ streamId, command }) => handOff(streamId, command));
window.fleet.agent.onToolStart(({ streamId, call }) => recordToolCall(streamId, call));
window.fleet.agent.onToolEnd(({ streamId, call }) => recordToolCall(streamId, call));
window.fleet.agent.onCompactDone(({ streamId, summary }) => applySummary(streamId, summary));
