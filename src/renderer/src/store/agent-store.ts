import { create } from 'zustand';
import type {
  AgentAttachment,
  AgentCatalog,
  AgentMessage,
  AgentPermissionAsk,
  AgentPermissionOutcome,
  AgentTurnUsage
} from '../../../shared/agent-types';
import {
  EMPTY_SESSION_SPEND,
  addTurn,
  hasSpend,
  type AgentSessionSpend
} from '../../../shared/agent-spend';
import { messageText, textMessage, userMessageWithAttachments } from '../../../shared/agent-types';
import type { AgentToolCall } from '../../../shared/agent-tools';
import { hasOpenWork, type AgentTodoItem } from '../../../shared/agent-todos';
import {
  emptyReplay,
  type AgentSessionEvent,
  type AgentSessionReplay
} from '../../../shared/agent-session';
import {
  canCompact,
  contextUsed,
  estimateTranscriptTokens,
  shouldCompact,
  splitForCompaction
} from '../../../shared/agent-context';
import { useSettingsStore } from './settings-store';
import { useNotificationStore } from './notification-store';
import { registerPaneDisposer, useWorkspaceStore } from './workspace-store';
import { draftInto } from '../hooks/use-terminal';
import { createLogger } from '../logger';
import type { ActivityState } from '../../../shared/types';

const log = createLogger('store:agent');

/**
 * Tell the rest of the app what this pane is doing.
 *
 * Everything that answers "which pane wants me?" - the sidebar glyph, the tab
 * badge, the agent overview, and both palette commands - reads the one
 * activity map. Terminals are put there by main, which watches their process;
 * an agent pane has no process to watch, so it says so itself. Without this a
 * turn stopped on a permission question is visible only to whoever is already
 * looking at that pane, which is the one person who does not need telling.
 */
function reportActivity(paneId: string, state: ActivityState): void {
  const now = Date.now();
  const store = useNotificationStore.getState();
  const previous = store.getActivity(paneId)?.state;
  if (previous === state) return;

  store.setActivity({ paneId, state, lastOutputAt: now, timestamp: now });
  // And again to main, which draws the dock badge and the window title and
  // decides whether this is worth a sound or a desktop notification. It cannot
  // work any of that out for itself: an agent pane has no process to watch.
  //
  // The folder rides along because a desktop notification has no sidebar to
  // point at: "an agent needs your permission" is the one fact the user with
  // four panes running already has.
  window.fleet.activity.report({ paneId, state, label: folderName(paneId) });
}

/** The last segment of the pane's working folder, as something to call it. */
function folderName(paneId: string): string | undefined {
  const cwd = useAgentStore.getState().threads[paneId]?.cwd;
  if (cwd === undefined || cwd === '') return undefined;
  return cwd.split(/[/\\]/).filter(Boolean).at(-1);
}

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
   * Set while the session's own history is still being read off disk.
   *
   * A turn sent in that window would carry an empty history - the transcript
   * arrives afterwards and is prepended, so it would look answered in context
   * when it was not. The pane waits instead, the same way it waits on a turn.
   */
  loading: boolean;
  /**
   * Set while the in-flight work is a compaction rather than a reply, holding
   * the tail that will survive it. Captured when the compaction starts, not
   * recomputed when it finishes: the summary must replace exactly what was sent
   * to be summarized, whatever else has happened since.
   */
  pendingCompact: { keep: AgentMessage[] } | null;
  /**
   * A command waiting on the user, drawn on the row of the call that asked.
   * Never more than one: the turn runs its tools in order and this one is
   * stopped until it is answered.
   */
  pendingPermission: AgentPermissionAsk | null;
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
  /**
   * What this session has spent, everything Fleet paid for included: the turns,
   * the compactions nobody asked for, the call that named it, and any pictures
   * it made. It is the number the user's OpenRouter invoice will agree with,
   * which it can only be by counting the spending they did not initiate.
   *
   * Kept here rather than derived from the transcript because most of it is not
   * in the transcript - and because compaction throws away the messages while
   * leaving the money spent on them exactly as spent.
   */
  spend: AgentSessionSpend;
  /**
   * Which model and upstream actually served the last turn, which `:auto` and a
   * provider fallback can both make different from what was asked for.
   *
   * Live only, and deliberately not written down. It describes one turn rather
   * than the session, so a value replayed from disk would be a claim about
   * whoever happens to answer next - and the settings already say what was
   * asked for, which is the answer for a session that has not run a turn yet.
   */
  served: { model: string | null; provider: string | null } | null;
  /**
   * The tasks the agent set itself, newest state of each. Empty for a thread
   * that never made a list.
   *
   * Owned here rather than in main for the same reason the transcript is: it
   * has to survive a restart, and this is the side that already knows how to
   * write things down. Main is handed it with each request and hands back
   * whatever it did to it.
   */
  todos: AgentTodoItem[];
  /**
   * The latest half-drawn render for each running image call, as a data URL.
   *
   * Never written to disk and never part of the transcript: a partial is what
   * the wait looks like, not what happened. It is dropped the moment its call
   * ends, so a finished image is never shown with an older draft of itself
   * still on screen, and a session replayed from disk shows none of them.
   */
  imagePartials: Record<string, string>;
};

const EMPTY_THREAD: PaneThread = {
  messages: [],
  cwd: '',
  sessionId: null,
  streamId: null,
  loading: false,
  pendingCompact: null,
  pendingPermission: null,
  startedAt: null,
  error: null,
  contextTokens: null,
  spend: EMPTY_SESSION_SPEND,
  served: null,
  todos: [],
  imagePartials: {}
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
  /**
   * Start this pane on a fresh session. What was said stays on disk under the
   * old id; the pane simply stops being the place it is read back into.
   */
  startNewSession: (paneId: string, cwd: string) => void;
  /**
   * Put a session this pane wrote earlier back on screen, in place. Unlike
   * `openSession` this deliberately replaces whatever the pane is showing,
   * which is why it cannot be the same call.
   */
  resumeSession: (paneId: string, cwd: string, sessionId: string) => Promise<void>;
  send: (paneId: string, cwd: string, text: string, attachments?: AgentAttachment[]) => void;
  /** Folds the older half of the transcript into a summary. Ignored while busy. */
  compact: (paneId: string) => void;
  cancel: (paneId: string) => void;
  /** Answer the command waiting on this pane. Nothing is decided here: main is. */
  decidePermission: (paneId: string, outcome: AgentPermissionOutcome) => void;
  /** The pane is gone: stop its turn and forget it. */
  disposePane: (paneId: string) => void;
  /** The user is looking at this pane: drop a badge that has now been read. */
  markSeen: (paneId: string) => void;
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
    // recorded against the right session rather than going unwritten. The id is
    // already the layout's, so unlike the two below this does not write it back.
    claimSession(paneId, cwd, sessionId);
    await replayInto(paneId, sessionId);
  },

  startNewSession: (paneId, cwd) => {
    if (!canSwitch(paneId)) return;
    const sessionId = crypto.randomUUID();
    log.debug('startNewSession', { paneId, sessionId });
    // The file itself waits for a first event, so a session cleared and never
    // used leaves nothing behind, and there is nothing to read back.
    switchTo(paneId, cwd, sessionId);
  },

  resumeSession: async (paneId, cwd, sessionId) => {
    if (!canSwitch(paneId)) return;
    switchTo(paneId, cwd, sessionId);
    await replayInto(paneId, sessionId);
  },

  send: (paneId, cwd, text, attachments = []) => {
    const thread = get().threads[paneId] ?? EMPTY_THREAD;
    // A turn sent before the history arrives would be answered without it.
    if (thread.streamId !== null || thread.loading) return;

    // A list with nothing open on it belongs to the job that just finished, and
    // the message being sent now is the next one. Carrying it forward would
    // leave the pane showing a plan the user has moved on from, count this
    // request's progress as `7/10` when none of it is done, spend the model's
    // context re-reading finished items every round, and - because nothing is
    // ever removed - eventually fill the list with work nobody is waiting on.
    // Clearing it also puts the model back in front of the nudge that starts a
    // list, which a settled list otherwise silences for the rest of the
    // session. What it costs is the finished list itself, which is gone from
    // the pane the moment the next message is sent; the reply that described
    // the work is still in the transcript, which is where an account of what
    // happened belongs.
    const spent = thread.todos.length > 0 && !hasOpenWork(thread.todos);
    const todos = spent ? [] : thread.todos;
    if (spent) record(thread, { t: 'todos', items: [] });

    const streamId = crypto.randomUUID();
    const user = userMessageWithAttachments(crypto.randomUUID(), text, attachments);
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
          todos,
          streamId,
          startedAt: Date.now(),
          error: null
        }
      }
    });
    reportActivity(paneId, 'working');
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
      text,
      attachments,
      todos
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
    reportActivity(paneId, 'working');
    window.fleet.agent.compact({ streamId, cwd: thread.cwd, messages: older });
  },

  cancel: (paneId) => {
    const streamId = get().threads[paneId]?.streamId;
    if (streamId) window.fleet.agent.cancel(streamId);
  },

  decidePermission: (paneId, outcome) => {
    const thread = get().threads[paneId];
    const ask = thread?.pendingPermission;
    if (!thread || !ask) return;
    // Cleared here rather than on an answer from main: the question has been
    // answered, and leaving the buttons up while the command starts reads as
    // though the click was missed.
    set({ threads: { ...get().threads, [paneId]: { ...thread, pendingPermission: null } } });
    // Answered, so the turn is the agent's again and the pane stops asking for
    // attention it no longer needs.
    reportActivity(paneId, 'working');
    window.fleet.agent.decidePermission({ requestId: ask.requestId, outcome });
  },

  /*
   * Cancelling is the point, not the tidying. A turn stopped on a permission
   * question has no other way to end - main is waiting on a click that can no
   * longer be made, and the pane that would have made it is the one closing.
   */
  disposePane: (paneId) => {
    get().cancel(paneId);
    useNotificationStore.getState().clearActivity(paneId);
    // Main is told outright, because it will not find out. `pane-closed` is
    // emitted by the PTY paths, and this pane never had one - so a record left
    // behind here is a dock badge that outlives the pane it counted.
    window.fleet.activity.report({ paneId, state: 'gone' });

    set((s) => {
      if (!s.threads[paneId]) return { threads: s.threads };
      const next = { ...s.threads };
      delete next[paneId];
      return { threads: next };
    });
  },

  /*
   * A badge is a message that has not been read yet, so reading it is what
   * takes it down. Left up, it is on screen next to the thing it is pointing
   * at, and a badge that survives being looked at teaches the user to stop
   * looking at badges.
   *
   * Only what the pane has already said: a question is still unanswered however
   * long it is looked at, and clearing that would take the pane out of "needs
   * you" while it still does.
   */
  markSeen: (paneId) => {
    // Only a pane this store speaks for. A terminal's state is main's, read off
    // a live process, and clearing it here would be a disagreement main wins
    // the moment the process says anything.
    if (get().threads[paneId] === undefined) return;
    const state = useNotificationStore.getState().getActivity(paneId)?.state;
    if (state !== 'done' && state !== 'error') return;
    reportActivity(paneId, 'idle');
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
  if (call.todos !== null) recordTodos(streamId, call.todos);
  updateStreaming(streamId, (m) => {
    // Stripped on the way in: the list travelled on this call so the pane
    // would hear about it, and it has now been heard. Left on the part it
    // would be written to the log as well, giving the file two accounts of the
    // same list - one of them a snapshot from whenever this call happened.
    const stored = { ...call, todos: null };
    const at = m.parts.findIndex((p) => p.type === 'tool' && p.call.id === call.id);
    const parts =
      at === -1
        ? [...m.parts, { type: 'tool' as const, call: stored }]
        : m.parts.map((p, i) => (i === at ? { type: 'tool' as const, call: stored } : p));
    return { ...m, parts };
  });
  // A call that has stopped running has nothing left to preview.
  if (call.result !== null || call.error !== null) forgetImagePartial(streamId, call.id);
}

/**
 * The task list, as the turn just left it.
 *
 * Written to the log here rather than when the turn ends, because this is when
 * it changed: a plan the agent got halfway through before the user stopped it
 * is worth keeping, and it is exactly the plan they will want to look at.
 */
function recordTodos(streamId: string, todos: AgentTodoItem[]): void {
  const found = threadOf(streamId);
  if (found === null) return;
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, todos } }
  }));
  record(found.thread, { t: 'todos', items: todos });
}

/** The newest render of an image still being generated, for its own row. */
function recordImagePartial(streamId: string, callId: string, image: string): void {
  patchPartials(streamId, (partials) => ({ ...partials, [callId]: image }));
}

function forgetImagePartial(streamId: string, callId: string): void {
  patchPartials(streamId, (partials) =>
    callId in partials
      ? Object.fromEntries(Object.entries(partials).filter(([id]) => id !== callId))
      : partials
  );
}

function patchPartials(
  streamId: string,
  change: (partials: Record<string, string>) => Record<string, string>
): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const imagePartials = change(found.thread.imagePartials);
  if (imagePartials === found.thread.imagePartials) return;
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, imagePartials } }
  }));
}

/**
 * Put a command the agent cannot run in front of the user.
 *
 * Main knows the turn and the renderer knows the panes, so the two halves meet
 * here: the turn says which agent pane asked, the workspace says which terminal
 * is beside it, and the command is typed there for the user to run.
 */
/** Put a command's fate in front of the user, on the row of the call that made it. */
function askPermission(ask: AgentPermissionAsk): void {
  const found = threadOf(ask.streamId);
  if (found === null) return;
  log.debug('permission ask', { command: ask.command, reason: ask.reason });
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [found.paneId]: { ...found.thread, pendingPermission: ask } }
  }));
  reportActivity(found.paneId, 'needs_me');
}

function handOff(streamId: string, command: string): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const paneId = useWorkspaceStore.getState().terminalBeside(found.paneId);
  if (paneId === null) return;
  log.debug('handOff', { paneId, command });
  draftInto(paneId, command);
  // The command sits on a prompt until the user presses Enter, which is the
  // one thing this tool is for - so the terminal is waiting on them just as
  // surely as a permission question is, and used to say nothing at all.
  //
  // Reported to main rather than written here: that pane has a process, and
  // main is the one watching it. Main latches the state through the tracker
  // that owns it, so the echo of the typed command cannot clear it and the
  // user's Enter can.
  window.fleet.activity.report({ paneId, state: 'needs_me' });
}

function endTurn(streamId: string, error: string | null, usage: AgentTurnUsage | null): void {
  const found = threadOf(streamId);
  if (found === null) return;
  const { paneId, thread } = found;
  // A compaction that ended here rather than on its own channel was cancelled
  // or failed, so the transcript is untouched and so is what we know about it.
  const wasCompacting = thread.pendingCompact !== null;
  const contextTokens = wasCompacting
    ? thread.contextTokens
    : contextUsed(usage, estimateTranscriptTokens(thread.messages));
  // Counted however the turn ended. A turn that was cancelled half-way, or that
  // failed on its ninth round of tools, spent everything it spent getting
  // there - and a total that only counted the turns that worked would be at
  // its least trustworthy on exactly the days it mattered most.
  const spend = usage === null ? thread.spend : addTurn(thread.spend, usage);

  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [paneId]: {
        ...thread,
        streamId: null,
        pendingCompact: null,
        // A question the turn did not live to hear the answer to. Main refuses
        // it on its side when the turn ends, so the row must not keep asking.
        pendingPermission: null,
        startedAt: null,
        error,
        contextTokens,
        spend,
        // Only when this turn said. A turn that failed before the first chunk
        // names nobody, and the last answer's attribution is still the truest
        // thing on screen about who has been answering.
        served:
          usage?.model == null ? thread.served : { model: usage.model, provider: usage.provider }
      }
    }
  }));

  // The turn is over however it ended, so the pane is no longer waiting on
  // anyone. A failure keeps a badge, since the pane has something to say that
  // nobody watching another tab has seen - and so does a reply, which is the
  // whole reason someone left it running. A compaction that ended here was
  // cancelled or failed and produced no answer, so it announces nothing.
  const finished: ActivityState = wasCompacting ? 'idle' : 'done';
  reportActivity(paneId, error === null ? finished : 'error');

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
  // Unconditionally, compaction included: a compaction that ended here failed,
  // and a failed call is still a paid one.
  if (usage !== null) record(thread, { t: 'spend', total: spend });

  // Only a completed turn can trigger compaction. A failed one leaves the
  // transcript where it was, and a compaction triggering another compaction is
  // the loop this feature has to not have.
  if (error === null && !wasCompacting) {
    autoCompact(paneId);
    nameSession(thread);
  }
}

/**
 * Whether this pane is free to change session.
 *
 * Same rule as sending: a turn in flight is answered, not abandoned. A read in
 * flight is not a reason to refuse - the load that lands after the switch is
 * dropped by `replayInto`, so leaving instead of waiting costs nothing.
 */
function canSwitch(paneId: string): boolean {
  return (useAgentStore.getState().threads[paneId]?.streamId ?? null) === null;
}

/** Point a pane at a session and clear what the last one left on screen. */
function claimSession(paneId: string, cwd: string, sessionId: string): void {
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [paneId]: { ...EMPTY_THREAD, sessionId, cwd } }
  }));
}

/**
 * The same, and remembered: the id goes back to the layout, which is what makes
 * a session the pane returns to after a restart rather than a choice that lasts
 * until the window closes. Also clears a badge the old conversation earned.
 */
function switchTo(paneId: string, cwd: string, sessionId: string): void {
  claimSession(paneId, cwd, sessionId);
  useWorkspaceStore.getState().setAgentSession(paneId, sessionId);
  reportActivity(paneId, 'idle');
}

/** Flip a pane's read flag, unless it has moved to another session meanwhile. */
function setLoading(paneId: string, sessionId: string, loading: boolean): void {
  useAgentStore.setState((s) => {
    const thread = s.threads[paneId];
    if (thread?.sessionId !== sessionId) return s;
    return { threads: { ...s.threads, [paneId]: { ...thread, loading } } };
  });
}

/**
 * Read a session off disk and put it behind whatever the pane holds now.
 *
 * Anything already there was said while the file was being read, so it belongs
 * after the history rather than instead of it.
 */
async function replayInto(paneId: string, sessionId: string): Promise<void> {
  // Marked here rather than where the session is claimed, because this is the
  // only thing `loading` describes: a pane switched to a fresh session has
  // nothing to read, and would otherwise wait for a read that never happens.
  setLoading(paneId, sessionId, true);

  let replay: AgentSessionReplay;
  try {
    replay = await window.fleet.agent.loadSession(sessionId);
  } catch (err) {
    // The pane keeps whatever it has and stops waiting; a history that cannot
    // be read is not a reason to leave the composer disabled forever.
    log.warn('replay failed', { paneId, sessionId, error: String(err) });
    replay = emptyReplay();
  }
  const thread = useAgentStore.getState().threads[paneId];
  // The pane moved on while the file was being read - another session resumed,
  // or cleared. What this load carries belongs to a conversation nobody is
  // looking at any more.
  if (thread?.sessionId !== sessionId) return;
  log.debug('replayInto', { paneId, sessionId, messages: replay.messages.length });
  useAgentStore.setState((s) => ({
    threads: {
      ...s.threads,
      [paneId]: {
        ...thread,
        loading: false,
        messages: [...replay.messages, ...thread.messages],
        contextTokens: thread.contextTokens ?? replay.contextTokens,
        // What the pane already has wins, the same rule the context figure
        // follows: a turn that ran while the file was being read knows more
        // about the list than the file does. For the total the case is
        // theoretical rather than real - `send` refuses while `loading`, so
        // nothing can be spent during a read - and the rule is the same either
        // way, because the two totals cannot be added without counting the
        // file's turns twice.
        spend: hasSpend(thread.spend) ? thread.spend : replay.spend,
        todos: thread.todos.length > 0 ? thread.todos : replay.todos
      }
    }
  }));
}

/**
 * Ask the model to name a session, once, after the turn that made it a real
 * conversation.
 *
 * Nothing records that a session has been named. A session holds exactly one
 * user message at the end of exactly one turn in its whole life, so the test
 * below can be true only once, and stays false for every session resumed from
 * disk with a conversation already in it.
 */
function nameSession(thread: PaneThread): void {
  const { sessionId, cwd } = thread;
  if (sessionId === null) return;
  const users = thread.messages.filter((m) => m.role === 'user');
  if (users.length !== 1) return;
  const assistant = thread.messages.find((m) => m.role === 'assistant');

  void window.fleet.agent
    .generateTitle({
      firstUser: messageText(users[0]),
      firstAssistant: assistant ? messageText(assistant) : ''
    })
    .then(({ title, usage }) => {
      log.debug('nameSession', { sessionId, title });
      // Written against the session that asked, which is held above rather
      // than read back from the pane: by the time a name arrives the pane may
      // have cleared or resumed, and the old conversation's title landing in
      // the new one's file is exactly what that would cost.
      if (title !== null) {
        window.fleet.agent.appendSession({ sessionId, cwd, event: { t: 'title', title } });
      }
      // Charged against the pane rather than against `thread`, which is a
      // snapshot from before the call: a turn may well have finished while the
      // model was thinking of a name, and adding to the old copy would drop it.
      if (usage !== null) addSpend(sessionId, usage);
    });
}

/**
 * Fold spending into whichever pane is still showing this session.
 *
 * For money that arrives after the turn that spent it has ended - a title, so
 * far. The pane is found by session rather than held, because by the time an
 * answer comes back the pane may have moved on, and a total is a fact about a
 * conversation rather than about the window it was in. When no pane is showing
 * it any more the figure is dropped: writing it would mean appending to a file
 * nothing has read, against a total that may since have moved on.
 */
function addSpend(sessionId: string, usage: AgentTurnUsage): void {
  const entry = Object.entries(useAgentStore.getState().threads).find(
    ([, thread]) => thread?.sessionId === sessionId
  );
  if (entry === undefined) return;
  const [paneId, thread] = entry;
  if (thread === undefined) return;

  const spend = addTurn(thread.spend, usage);
  useAgentStore.setState((s) => ({
    threads: { ...s.threads, [paneId]: { ...thread, spend } }
  }));
  record(thread, { t: 'spend', total: spend });
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

function applySummary(streamId: string, summary: string, usage: AgentTurnUsage | null): void {
  const found = threadOf(streamId);
  const pending = found?.thread.pendingCompact;
  // No compaction in flight under this id: a summary from a pane that has
  // already moved on, which must not be allowed to rewrite the transcript.
  if (!found || !pending) return;

  const message = textMessage(crypto.randomUUID(), 'summary', summary);
  const messages = [message, ...pending.keep];
  const contextTokens = estimateTranscriptTokens(messages);
  // Nobody asked for this call, which is the reason to count it rather than a
  // reason not to: unprompted spending is the kind a person most wants to find
  // accounted for when they go looking for where the money went.
  const spend = usage === null ? found.thread.spend : addTurn(found.thread.spend, usage);

  // One line saying what replaced what, rather than a rewrite: the turns the
  // summary folded up stay in the file, and replay reaches the same transcript
  // the pane is showing.
  record(found.thread, { t: 'compact', summary: message, keep: pending.keep.map((m) => m.id) });
  record(found.thread, { t: 'context', tokens: contextTokens });
  if (usage !== null) record(found.thread, { t: 'spend', total: spend });

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
        contextTokens,
        spend
      }
    }
  }));
}

// Installed once: there is a single main→renderer channel per event, and every
// event carries the id of the turn that produced it.
window.fleet.agent.onStreamChunk(({ streamId, delta }) => appendText(streamId, delta));
window.fleet.agent.onStreamReasoning(({ streamId, delta }) => appendReasoning(streamId, delta));
window.fleet.agent.onStreamDone(({ streamId, usage }) => endTurn(streamId, null, usage));
window.fleet.agent.onStreamError(({ streamId, message, usage }) => {
  log.warn('stream error', { message });
  // The rounds before the failure were paid for, so the total takes them the
  // same way a finished turn's would.
  endTurn(streamId, message, usage);
});
window.fleet.agent.onHandOff(({ streamId, command }) => handOff(streamId, command));
window.fleet.agent.onPermissionAsk((ask) => askPermission(ask));
window.fleet.agent.onToolStart(({ streamId, call }) => recordToolCall(streamId, call));
window.fleet.agent.onToolEnd(({ streamId, call }) => recordToolCall(streamId, call));
window.fleet.agent.onImagePartial(({ streamId, callId, image }) =>
  recordImagePartial(streamId, callId, image)
);
window.fleet.agent.onCompactDone(({ streamId, summary, usage }) =>
  applySummary(streamId, summary, usage)
);

// A pane closing mid-turn is the one case a turn cannot end on its own: main is
// waiting on a click, and the pane that would have made it is the one going.
registerPaneDisposer((paneId) => {
  useAgentStore.getState().disposePane(paneId);
});
