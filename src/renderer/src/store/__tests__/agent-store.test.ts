import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import { messageText, textMessage } from '../../../../shared/agent-types';
import type { AgentCatalogModel, AgentMessage, AgentUsage } from '../../../../shared/agent-types';
import type { AgentToolCall } from '../../../../shared/agent-tools';
import {
  emptyReplay,
  type AgentSessionAppend,
  type AgentSessionEvent,
  type AgentSessionReplay
} from '../../../../shared/agent-session';
import type * as AgentStore from '../agent-store';
import type * as SettingsStore from '../settings-store';
import type * as WorkspaceStore from '../workspace-store';
import type * as NotificationStore from '../notification-store';

/**
 * Compaction, from the pane's side: when it fires on its own, when it must not,
 * and what the transcript looks like afterwards. Nearly all of the risk in this
 * feature is here - a compaction that loops, or that fires on a conversation
 * too short to have anything to lose, costs money and destroys context without
 * anything on screen looking wrong.
 */

type Listener = (payload: unknown) => void;

const MODEL = 'anthropic/claude-sonnet-4.5';
const CONTEXT_LIMIT = 100_000;
const PANE = 'pane-1';

const listeners = new Map<string, Listener>();
/** What the pane tells main about itself, so the dock and the sound follow. */
const activityApi = {
  report: vi.fn(),
  visiblePanes: vi.fn(),
  onChime: vi.fn().mockReturnValue(() => {}),
  onStateChange: vi.fn().mockReturnValue(() => {})
};

const agentApi = {
  send: vi.fn(),
  compact: vi.fn(),
  cancel: vi.fn(),
  appendSession: vi.fn(),
  decidePermission: vi.fn(),
  deleteSession: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([]),
  generateTitle: vi.fn().mockResolvedValue(null)
};

/** What `loadSession` hands back; set per test to stand in for a file. */
let replay: AgentSessionReplay;

// Loaded per test rather than at the top: the store installs its IPC listeners
// on import, so the bridge has to exist first.
let agentStore: typeof AgentStore;
let settingsStore: typeof SettingsStore;
let notificationStore: typeof NotificationStore;

const catalogModel: AgentCatalogModel = {
  id: MODEL,
  name: 'Sonnet',
  description: null,
  contextLimit: CONTEXT_LIMIT,
  outputLimit: 64_000,
  supportsTools: true,
  supportsTemperature: true,
  inputImage: false,
  outputImage: false,
  reasoning: [],
  cost: null,
  releaseDate: null,
  defaultTemperature: null,
  defaultReasoningEnabled: null,
  defaultReasoningEffort: null
};

const listen =
  (channel: string) =>
  (cb: Listener): (() => void) => {
    listeners.set(channel, cb);
    return () => {};
  };

/** Deliver one main→renderer event, the way the preload bridge would. */
function emit(channel: string, payload: unknown): void {
  const cb = listeners.get(channel);
  if (!cb) throw new Error(`nothing listening on ${channel}`);
  cb(payload);
}

function thread(
  paneId = PANE
): NonNullable<ReturnType<typeof agentStore.useAgentStore.getState>['threads'][string]> {
  const found = agentStore.useAgentStore.getState().threads[paneId];
  if (!found) throw new Error(`no thread for ${paneId}`);
  return found;
}

/** A message that is only words, as an assertion. */
const said = (role: AgentMessage['role'], text: string): unknown =>
  expect.objectContaining({ role, parts: [{ type: 'text', text }] });

/** The calls on the message the pane is streaming into. */
function calls(paneId = PANE): AgentToolCall[] {
  const last = thread(paneId).messages.at(-1);
  return (last?.parts ?? []).flatMap((p) => (p.type === 'tool' ? [p.call] : []));
}

/** The id main would be tagging this pane's events with right now. */
function liveStreamId(paneId = PANE): string {
  const id = thread(paneId).streamId;
  if (id === null) throw new Error('nothing in flight');
  return id;
}

/** One complete exchange: ask, receive, and report what it cost. */
function turn(text: string, usage: AgentUsage | null = null): void {
  agentStore.useAgentStore.getState().send(PANE, '/repo', text);
  const streamId = liveStreamId();
  emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: `reply to ${text}` });
  emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage });
}

const usageOf = (total: number): AgentUsage => ({
  promptTokens: total - 100,
  completionTokens: 100,
  totalTokens: total
});

/** Sets the threshold, or turns automatic compaction off with `null`. */
function setThreshold(compactThreshold: number | null): void {
  settingsStore.useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        agent: {
          ...DEFAULT_SETTINGS.ai.agent,
          coding: { ...DEFAULT_SETTINGS.ai.agent.coding, model: MODEL },
          compactThreshold
        }
      }
    }
  });
}

beforeEach(async () => {
  vi.resetModules();
  listeners.clear();
  replay = emptyReplay();

  Object.assign(window.fleet, {
    agent: {
      listModels: vi
        .fn()
        .mockResolvedValue({ models: [catalogModel], fetchedAt: 1, source: 'cache', error: null }),
      send: agentApi.send,
      compact: agentApi.compact,
      cancel: agentApi.cancel,
      appendSession: agentApi.appendSession,
      loadSession: vi.fn().mockImplementation(async () => Promise.resolve(replay)),
      listSessions: agentApi.listSessions,
      deleteSession: agentApi.deleteSession,
      generateTitle: agentApi.generateTitle,
      onStreamChunk: listen(IPC_CHANNELS.AGENT_STREAM_CHUNK),
      onStreamReasoning: listen(IPC_CHANNELS.AGENT_STREAM_REASONING),
      onStreamDone: listen(IPC_CHANNELS.AGENT_STREAM_DONE),
      onStreamError: listen(IPC_CHANNELS.AGENT_STREAM_ERROR),
      onCompactDone: listen(IPC_CHANNELS.AGENT_COMPACT_DONE),
      onToolStart: listen(IPC_CHANNELS.AGENT_TOOL_START),
      onToolEnd: listen(IPC_CHANNELS.AGENT_TOOL_END),
      onHandOff: listen(IPC_CHANNELS.AGENT_HAND_OFF),
      onPermissionAsk: listen(IPC_CHANNELS.AGENT_PERMISSION_ASK),
      decidePermission: agentApi.decidePermission
    },
    pty: { input: vi.fn() },
    activity: activityApi,
    chat: {
      hasKey: vi.fn().mockResolvedValue(true),
      setKey: vi.fn().mockResolvedValue(undefined),
      clearKey: vi.fn().mockResolvedValue(undefined)
    }
  });

  // Imported after the bridge exists: the store installs its listeners when the
  // module first loads.
  agentStore = await import('../agent-store');
  settingsStore = await import('../settings-store');
  notificationStore = await import('../notification-store');
  activityApi.report.mockClear();
  agentStore.useAgentStore.setState({
    catalog: { models: [catalogModel], fetchedAt: 1, source: 'cache', error: null },
    threads: {}
  });
  setThreshold(0.8);
});

describe('context accounting', () => {
  it('records what the provider says the turn cost', () => {
    turn('hello', usageOf(12_000));

    expect(thread().contextTokens).toBe(12_000);
  });

  it('estimates the size when the provider reports no usage', () => {
    turn('hello', null);

    expect(thread().contextTokens).toBeGreaterThan(0);
  });

  it('knows nothing before the first turn ends', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    expect(thread().contextTokens).toBeNull();
  });
});

describe('automatic compaction', () => {
  /** Four exchanges, the last of which fills the window past the threshold. */
  function fillPastThreshold(): void {
    turn('one', usageOf(10_000));
    turn('two', usageOf(30_000));
    turn('three', usageOf(60_000));
    turn('four', usageOf(85_000));
  }

  it('fires once a completed turn passes the threshold', () => {
    fillPastThreshold();

    expect(agentApi.compact).toHaveBeenCalledTimes(1);
    const [req] = agentApi.compact.mock.calls[0];
    expect(req).toMatchObject({ cwd: '/repo' });
    // The oldest exchanges go; the recent tail is not sent to be summarized.
    expect(req.messages).toHaveLength(4);
    expect(messageText(req.messages[0])).toBe('one');
    expect(thread().pendingCompact?.keep).toHaveLength(4);
  });

  it('does not fire when the user has turned it off', () => {
    setThreshold(null);
    fillPastThreshold();

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('does not fire when the catalog does not know the context limit', () => {
    // Nothing to take a percentage of, so the transcript is left alone rather
    // than compacted on a guess.
    agentStore.useAgentStore.setState({
      catalog: {
        models: [{ ...catalogModel, contextLimit: null }],
        fetchedAt: 1,
        source: 'cache',
        error: null
      }
    });
    fillPastThreshold();

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('does not fire below the threshold', () => {
    turn('one', usageOf(10_000));
    turn('two', usageOf(30_000));
    turn('three', usageOf(79_000));

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('does not fire on a conversation with nothing to summarize', () => {
    // A single enormous exchange can fill the window on its own. There is no
    // older half to fold up, and summarizing the turn the user is working on
    // would throw away the only thing in the pane.
    turn('one', usageOf(99_000));

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('does not fire on a failed turn', () => {
    turn('one', usageOf(10_000));
    turn('two', usageOf(30_000));
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'three');
    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, {
      streamId: liveStreamId(),
      message: 'Rate limited'
    });

    expect(agentApi.compact).not.toHaveBeenCalled();
    expect(thread().error).toBe('Rate limited');
  });
});

describe('applying a compaction', () => {
  function compacted(summary = 'They chose zod over casts.'): void {
    turn('one', usageOf(10_000));
    turn('two', usageOf(30_000));
    turn('three', usageOf(60_000));
    turn('four', usageOf(85_000));
    emit(IPC_CHANNELS.AGENT_COMPACT_DONE, {
      streamId: liveStreamId(),
      summary,
      usage: usageOf(500)
    });
  }

  it('replaces the summarized messages and keeps the recent tail verbatim', () => {
    compacted();

    const { messages } = thread();
    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe('summary');
    expect(messageText(messages[0])).toBe('They chose zod over casts.');
    expect(messages.slice(1).map(messageText)).toEqual([
      'three',
      'reply to three',
      'four',
      'reply to four'
    ]);
  });

  it('frees the pane and re-estimates what is left', () => {
    compacted();

    expect(thread().streamId).toBeNull();
    expect(thread().pendingCompact).toBeNull();
    expect(thread().error).toBeNull();
    // The summarizing call's own token count describes that call, not this
    // transcript, so the figure on screen is an estimate of what remains.
    expect(thread().contextTokens).toBeGreaterThan(0);
    expect(thread().contextTokens).toBeLessThan(85_000);
  });

  it('does not immediately compact its own result', () => {
    // The loop this feature has to not have: nothing about applying a summary
    // may start another summarization.
    compacted();

    expect(agentApi.compact).toHaveBeenCalledTimes(1);
  });

  it('ignores a summary for a compaction that is no longer in flight', () => {
    turn('one', usageOf(10_000));
    const before = thread().messages;

    emit(IPC_CHANNELS.AGENT_COMPACT_DONE, {
      streamId: 'stale',
      summary: 'from a pane that closed',
      usage: null
    });

    expect(thread().messages).toEqual(before);
  });
});

describe('a compaction that does not finish', () => {
  function compacting(): void {
    turn('one', usageOf(10_000));
    turn('two', usageOf(30_000));
    turn('three', usageOf(60_000));
    turn('four', usageOf(85_000));
  }

  it('keeps the transcript when the summary fails, and does not retry', () => {
    compacting();
    const before = thread().messages;

    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, {
      streamId: liveStreamId(),
      message: 'The model returned an empty summary'
    });

    expect(thread().messages).toEqual(before);
    expect(thread().error).toBe('The model returned an empty summary');
    expect(thread().streamId).toBeNull();
    expect(agentApi.compact).toHaveBeenCalledTimes(1);
  });

  it('keeps the transcript, and the measured size, when it is cancelled', () => {
    compacting();
    const before = thread().messages;

    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId: liveStreamId(), usage: null });

    expect(thread().messages).toEqual(before);
    expect(thread().pendingCompact).toBeNull();
    // Still the provider's number for the last real turn, not an estimate that
    // quietly replaced it.
    expect(thread().contextTokens).toBe(85_000);
    expect(agentApi.compact).toHaveBeenCalledTimes(1);
  });
});

describe('compacting on request', () => {
  it('is ignored while a turn is in flight', () => {
    setThreshold(null);
    turn('one');
    turn('two');
    turn('three');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'four');

    agentStore.useAgentStore.getState().compact(PANE);

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('is ignored when there is nothing older to fold up', () => {
    setThreshold(null);
    turn('one');

    agentStore.useAgentStore.getState().compact(PANE);

    expect(agentApi.compact).not.toHaveBeenCalled();
  });

  it('runs even with automatic compaction turned off', () => {
    setThreshold(null);
    turn('one');
    turn('two');
    turn('three');

    agentStore.useAgentStore.getState().compact(PANE);

    expect(agentApi.compact).toHaveBeenCalledTimes(1);
    expect(thread().pendingCompact).not.toBeNull();
  });
});

/**
 * The number the collapsed reasoning block shows for itself. Getting it wrong
 * is quiet: a plausible duration on the wrong message reads as fact.
 */
describe('reasoning duration', () => {
  const send = (): string => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'why?');
    return liveStreamId();
  };
  const assistant = (): AgentMessage => {
    const last = thread().messages.at(-1);
    if (!last) throw new Error('no messages');
    return last;
  };

  it('stamps the wait when the first answer token follows reasoning', () => {
    vi.useFakeTimers();
    try {
      const streamId = send();
      emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta: 'let me think' });
      vi.advanceTimersByTime(4_000);
      emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'because' });

      expect(assistant().reasoningMs).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first stamp as the rest of the answer streams in', () => {
    vi.useFakeTimers();
    try {
      const streamId = send();
      emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta: 'hm' });
      vi.advanceTimersByTime(2_000);
      emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'be' });
      vi.advanceTimersByTime(9_000);
      emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'cause' });

      expect(assistant().reasoningMs).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // No reasoning means there is nothing to label, and a duration would turn
  // ordinary latency into a claim the model was thinking.
  it('leaves a reply with no reasoning unstamped', () => {
    const streamId = send();
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'sure' });

    expect(assistant().reasoningMs).toBeNull();
  });

  it('leaves reasoning that never reached an answer unstamped', () => {
    const streamId = send();
    emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta: 'thinking…' });
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });

    expect(assistant().reasoningMs).toBeNull();
  });
});

/**
 * What ends up in the session log. The transcript on screen and the transcript
 * on disk have to be the same conversation - a missing or mis-ordered event is
 * invisible until a restart, when it turns into a conversation the user did not
 * have.
 */
describe('session log', () => {
  const SESSION = 'session-1';

  /** Every event written so far, in order. */
  const written = (): AgentSessionEvent[] =>
    agentApi.appendSession.mock.calls.map(([req]) => (req as AgentSessionAppend).event);

  const open = async (): Promise<void> => {
    await agentStore.useAgentStore.getState().openSession(PANE, SESSION, '/repo');
  };

  it('writes the question before the answer comes back', async () => {
    await open();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    expect(written()).toEqual([{ t: 'message', message: said('user', 'hello') }]);
  });

  it('writes the reply once, when it stops changing', async () => {
    await open();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');
    const streamId = liveStreamId();
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'hi ' });
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'there' });
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: usageOf(500) });

    expect(written()).toEqual([
      { t: 'message', message: expect.objectContaining({ role: 'user' }) },
      {
        t: 'message',
        message: said('assistant', 'hi there')
      },
      { t: 'context', tokens: 500 }
    ]);
  });

  // Whatever the pane is showing is what the next turn will send, so it is
  // also what the file has to say.
  it('keeps the part of a failed turn that reached the screen', async () => {
    await open();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');
    const streamId = liveStreamId();
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'half an ans' });
    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId, message: 'connection lost' });

    expect(written()).toContainEqual({
      t: 'message',
      message: expect.objectContaining({ parts: [{ type: 'text', text: 'half an ans' }] })
    });
  });

  it('writes nothing for a turn that produced no reply at all', async () => {
    await open();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');
    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId: liveStreamId(), message: 'no api key' });

    expect(written().filter((e) => e.t === 'message')).toHaveLength(1);
  });

  it('records a compaction as what replaced what', async () => {
    setThreshold(null);
    await open();
    turn('one');
    turn('two');
    turn('three');
    agentStore.useAgentStore.getState().compact(PANE);
    const keptIds = thread().pendingCompact?.keep.map((m) => m.id);
    emit(IPC_CHANNELS.AGENT_COMPACT_DONE, {
      streamId: liveStreamId(),
      summary: 'we talked about one',
      usage: null
    });

    expect(written()).toContainEqual({
      t: 'compact',
      summary: said('summary', 'we talked about one'),
      keep: keptIds
    });
  });

  it('replays a session into the thread when the pane opens', async () => {
    replay = {
      messages: [textMessage('a', 'user', 'earlier'), textMessage('b', 'assistant', 'answer')],
      contextTokens: 4_000,
      cwd: '/repo',
      title: null,
      firstUserText: '',
      skipped: 0
    };

    await open();

    expect(thread().messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(thread().contextTokens).toBe(4_000);
  });

  // The pane remounts on every layout change; a reload there would replace a
  // live conversation with whatever was last flushed.
  it('does not re-read the session over a thread that is already open', async () => {
    await open();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    await open();

    expect(thread().messages).toHaveLength(2);
  });

  // Nothing is recorded against a file we cannot name, and a turn in a pane
  // that never announced a session still works - it is just not written down.
  it('writes nothing for a pane that never announced a session', () => {
    turn('hello', usageOf(500));

    expect(thread().messages).toHaveLength(2);
    expect(agentApi.appendSession).not.toHaveBeenCalled();
  });
});

describe('tool calls', () => {
  const CALL = {
    id: 'call_1',
    name: 'read',
    args: '{"path":"a.ts"}',
    result: null,
    error: null,
    summary: null
  };

  const start = (streamId: string): void => {
    emit(IPC_CHANNELS.AGENT_TOOL_START, { streamId, call: CALL });
  };

  const finish = (streamId: string): void => {
    emit(IPC_CHANNELS.AGENT_TOOL_END, {
      streamId,
      call: { ...CALL, result: 'a.ts lines 1-1', summary: '1 line' }
    });
  };

  it('shows a call on the reply it belongs to', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'what is in a.ts?');
    start(liveStreamId());

    expect(calls()).toEqual([CALL]);
  });

  // The same call twice, not two calls: the row on screen fills in rather than
  // being joined by a second copy of itself.
  it('replaces the call in place when it finishes', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'what is in a.ts?');
    const streamId = liveStreamId();
    start(streamId);
    finish(streamId);

    expect(calls()).toEqual([{ ...CALL, result: 'a.ts lines 1-1', summary: '1 line' }]);
  });

  it('keeps two calls in the order they were made', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'look around');
    const streamId = liveStreamId();
    start(streamId);
    emit(IPC_CHANNELS.AGENT_TOOL_START, {
      streamId,
      call: { ...CALL, id: 'call_2', name: 'glob' }
    });

    expect(calls().map((c) => c.name)).toEqual(['read', 'glob']);
  });

  // The whole point of parts: what the model said before it looked stays
  // above the row, and what it said afterwards stays below it.
  it('keeps text on either side of a call in the order it arrived', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'what is in a.ts?');
    const streamId = liveStreamId();
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'Let me look.' });
    start(streamId);
    finish(streamId);
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: 'It says ' });
    emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta: '42.' });

    expect(thread().messages.at(-1)?.parts).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', call: expect.objectContaining({ id: 'call_1', summary: '1 line' }) },
      { type: 'text', text: 'It says 42.' }
    ]);
  });

  it('ignores a call for a pane that has no thread', () => {
    expect(() => start('stream-nobody-is-waiting-for')).not.toThrow();
  });

  it('records a turn that only ran tools', async () => {
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'look around');
    const streamId = liveStreamId();
    start(streamId);
    finish(streamId);
    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId, message: 'connection lost' });

    const events = agentApi.appendSession.mock.calls.map(
      ([req]) => (req as AgentSessionAppend).event
    );
    expect(events).toContainEqual({
      t: 'message',
      message: expect.objectContaining({
        role: 'assistant',
        parts: [{ type: 'tool', call: expect.objectContaining({ summary: '1 line' }) }]
      })
    });
  });
});

describe('handing a command to the user', () => {
  /** The pane's own tab, since the terminal has to open in that one. */
  const agentTab = {
    id: 'tab-agent',
    label: 'repo',
    labelIsCustom: true,
    cwd: '/repo',
    type: 'agent' as const,
    splitRoot: { type: 'leaf' as const, id: PANE, cwd: '/repo', paneType: 'agent' as const }
  };

  const workspaceWith = async (): Promise<typeof WorkspaceStore> => {
    const workspace = await import('../workspace-store');
    workspace.useWorkspaceStore.setState({
      workspace: { id: 'ws', label: 'W', tabs: [agentTab] },
      activeTabId: 'tab-agent',
      activePaneId: PANE
    });
    return workspace;
  };

  it('opens a terminal in the tab of the pane whose turn it is', async () => {
    const workspace = await workspaceWith();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'log me in');

    emit(IPC_CHANNELS.AGENT_HAND_OFF, {
      streamId: liveStreamId(),
      command: 'gh auth login'
    });

    const tab = workspace.useWorkspaceStore.getState().workspace.tabs[0];
    expect(workspace.collectPaneLeafs(tab.splitRoot)).toHaveLength(2);
  });

  /*
   * A command left on a prompt is waiting on the user exactly as a permission
   * question is - it is their Enter the whole tool exists to get - and it used
   * to say nothing at all to anyone not already looking at that terminal.
   *
   * Reported to main rather than written into the activity map here: that pane
   * has a process, and main is the one watching it. Anything written locally
   * would be undone by the echo of the command as it is typed.
   */
  it('says the terminal is now waiting on the user', async () => {
    const workspace = await workspaceWith();
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'log me in');
    activityApi.report.mockClear();

    emit(IPC_CHANNELS.AGENT_HAND_OFF, {
      streamId: liveStreamId(),
      command: 'gh auth login'
    });

    const tab = workspace.useWorkspaceStore.getState().workspace.tabs[0];
    const terminal = workspace.collectPaneLeafs(tab.splitRoot).find((leaf) => leaf.id !== PANE);
    expect(activityApi.report).toHaveBeenCalledWith({
      paneId: terminal?.id,
      state: 'needs_me'
    });
  });

  // The turn is how the command finds its pane, so a stale one has no pane to
  // find - and typing into whichever terminal happened to be open would be
  // worse than doing nothing.
  it('ignores a command from a turn that has already ended', async () => {
    const workspace = await workspaceWith();

    emit(IPC_CHANNELS.AGENT_HAND_OFF, { streamId: 'over-and-done', command: 'gh auth login' });

    const tab = workspace.useWorkspaceStore.getState().workspace.tabs[0];
    expect(workspace.collectPaneLeafs(tab.splitRoot)).toHaveLength(1);
  });
});

describe('asking the user about a command', () => {
  const ask = (streamId: string, command = 'npm test'): void =>
    emit(IPC_CHANNELS.AGENT_PERMISSION_ASK, {
      streamId,
      requestId: 'req-1',
      callId: 'call-1',
      command,
      reason: null,
      rule: 'npm test'
    });

  it('puts the question on the pane whose turn it is', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');

    ask(liveStreamId());

    expect(thread().pendingPermission).toMatchObject({ command: 'npm test' });
  });

  it('ignores a question from a turn that has already ended', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');

    ask('over-and-done');

    expect(thread().pendingPermission).toBeNull();
  });

  // Nothing is decided here: the click is relayed and main does the rest.
  it('relays the answer and takes the question down', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');
    ask(liveStreamId());

    agentStore.useAgentStore.getState().decidePermission(PANE, 'always');

    expect(agentApi.decidePermission).toHaveBeenCalledWith({
      requestId: 'req-1',
      outcome: 'always'
    });
    expect(thread().pendingPermission).toBeNull();
  });

  // Main refuses it on its side when the turn ends, so the row must not be
  // left offering to run something nothing is waiting for any more.
  it('takes the question down when the turn ends without an answer', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');
    const streamId = liveStreamId();
    ask(streamId);

    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });

    expect(thread().pendingPermission).toBeNull();
  });
});

/*
 * A pane that goes away while its turn is running is the one case the turn
 * cannot end by itself: main is waiting on a click, and the thing that would
 * have clicked is what is being closed.
 */
describe('disposing a pane', () => {
  it('stops the turn and forgets the thread', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');
    const streamId = liveStreamId();

    agentStore.useAgentStore.getState().disposePane(PANE);

    expect(agentApi.cancel).toHaveBeenCalledWith(streamId);
    expect(agentStore.useAgentStore.getState().threads[PANE]).toBeUndefined();
  });

  it('stops a turn that is stopped on a question', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'run the tests');
    const streamId = liveStreamId();
    emit(IPC_CHANNELS.AGENT_PERMISSION_ASK, {
      streamId,
      requestId: 'req-1',
      callId: 'call-1',
      command: 'npm test',
      reason: null,
      rule: 'npm test'
    });

    agentStore.useAgentStore.getState().disposePane(PANE);

    expect(agentApi.cancel).toHaveBeenCalledWith(streamId);
  });

  it('says nothing to main about a pane that was never used', () => {
    agentStore.useAgentStore.getState().disposePane('never-opened');

    expect(agentApi.cancel).not.toHaveBeenCalled();
  });
});

/**
 * A turn stopped on a question is the one moment the pane has something to say
 * to someone who is not looking at it. Everything that answers "which pane
 * wants me?" reads the activity map, and an agent pane has no process for main
 * to watch, so what it puts there is all anybody outside the pane ever sees.
 */
describe('telling the rest of the app it is blocked', () => {
  /** The state the sidebar, the tab badge and both palette commands would read. */
  const activityOf = (paneId = PANE): string | undefined =>
    notificationStore.useNotificationStore.getState().getActivity(paneId)?.state;

  function ask(requestId = 'req-1'): void {
    emit(IPC_CHANNELS.AGENT_PERMISSION_ASK, {
      streamId: liveStreamId(),
      requestId,
      callId: 'call-1',
      command: 'rm -rf /tmp/x',
      reason: 'Deletes a folder outside the working folder.',
      rule: null
    });
  }

  /** Every state this pane reported to main, in order. */
  const reported = (): unknown[] => activityApi.report.mock.calls.map((call) => call[0]?.state);

  it('marks the pane as wanting the user, and tells main so', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();

    expect(activityOf()).toBe('needs_me');
    // Main draws the dock badge and decides whether this is worth a sound; it
    // has no process here to learn any of it from.
    expect(reported()).toEqual(['working', 'needs_me']);
  });

  it('names the folder it is asking about, for a notification with no sidebar', () => {
    agentStore.useAgentStore.getState().send(PANE, '/Users/x/work/fleet', 'clean up');
    ask();

    expect(activityApi.report).toHaveBeenLastCalledWith({
      paneId: PANE,
      state: 'needs_me',
      label: 'fleet'
    });
  });

  it('is working, not waiting, while the turn runs', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');

    expect(activityOf()).toBe('working');
    expect(reported()).toEqual(['working']);
  });

  it('stops asking once the question is answered', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();

    agentStore.useAgentStore.getState().decidePermission(PANE, 'once');

    expect(activityOf()).toBe('working');
  });

  // A question that is still waiting is not a new question, and main turns each
  // report into a sound or a banner.
  it('reports one question once, however often it is re-announced', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();
    ask();

    expect(reported()).toEqual(['working', 'needs_me']);
  });

  it('has something to say when the turn finishes, not nothing', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    const streamId = liveStreamId();
    ask();

    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });

    // The reply is the whole reason someone left it running, so the pane keeps
    // a badge until it has been looked at.
    expect(activityOf()).toBe('done');
  });

  it('drops the badge once the user has seen the pane, but never an open question', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    const streamId = liveStreamId();
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId, usage: null });

    agentStore.useAgentStore.getState().markSeen(PANE);
    expect(activityOf()).toBe('idle');

    agentStore.useAgentStore.getState().send(PANE, '/repo', 'again');
    ask();
    agentStore.useAgentStore.getState().markSeen(PANE);
    expect(activityOf()).toBe('needs_me');
  });

  it('leaves a pane it does not speak for alone', () => {
    notificationStore.useNotificationStore.getState().setActivity({
      paneId: 'a-terminal',
      state: 'error',
      lastOutputAt: 0,
      timestamp: 0
    });

    agentStore.useAgentStore.getState().markSeen('a-terminal');

    // Main watches that pane off a live process and would put back anything
    // cleared behind its back.
    expect(activityOf('a-terminal')).toBe('error');
  });

  it('keeps a badge on a turn that failed', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    const streamId = liveStreamId();

    emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId, message: 'no key' });

    expect(activityOf()).toBe('error');
  });

  // How loud to be is main's to decide, from where the user is and what they
  // allowed; the pane's job is to say what happened either way.
  it('reports the question whatever the user has silenced', () => {
    settingsStore.useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          needsPermission: { badge: false, sound: false, os: false }
        }
      }
    });
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();

    expect(activityOf()).toBe('needs_me');
    expect(reported()).toEqual(['working', 'needs_me']);
  });

  // Otherwise "jump to the agent that needs input" has somewhere to send the
  // user that no longer exists, and silently does nothing when it gets there.
  it('forgets a closed pane rather than leaving it asking forever', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();

    agentStore.useAgentStore.getState().disposePane(PANE);

    expect(activityOf()).toBeUndefined();
  });

  // Main will not find out on its own: `pane-closed` is emitted by the PTY
  // paths and this pane never had one, so the dock would keep counting a
  // question nobody can answer any more.
  it('tells main the pane is gone, since nothing else will', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'clean up');
    ask();

    agentStore.useAgentStore.getState().disposePane(PANE);

    expect(activityApi.report).toHaveBeenLastCalledWith({ paneId: PANE, state: 'gone' });
  });
});

/**
 * Clearing and resuming both replace what a pane is showing, which is exactly
 * what `openSession` refuses to do. The id also has to reach the layout, since
 * that is what the pane comes back to after a restart.
 */
describe('switching sessions', () => {
  const OTHER = 'session-2';

  const agentTab = {
    id: 'tab-agent',
    label: 'repo',
    labelIsCustom: true,
    cwd: '/repo',
    type: 'agent' as const,
    splitRoot: {
      type: 'leaf' as const,
      id: PANE,
      cwd: '/repo',
      paneType: 'agent' as const,
      agentSessionId: 'session-1'
    }
  };

  const workspaceWith = async (): Promise<typeof WorkspaceStore> => {
    const workspace = await import('../workspace-store');
    workspace.useWorkspaceStore.setState({
      workspace: { id: 'ws', label: 'W', tabs: [agentTab] },
      activeTabId: 'tab-agent',
      activePaneId: PANE
    });
    return workspace;
  };

  const leafSession = (workspace: typeof WorkspaceStore): string | undefined => {
    const leafs = workspace.collectPaneLeafs(
      workspace.useWorkspaceStore.getState().workspace.tabs[0].splitRoot
    );
    return leafs.find((l) => l.id === PANE)?.agentSessionId;
  };

  it('gives a cleared pane a new session, and tells the layout about it', async () => {
    const workspace = await workspaceWith();
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId: liveStreamId(), usage: null });

    agentStore.useAgentStore.getState().startNewSession(PANE, '/repo');

    expect(thread().messages).toEqual([]);
    expect(thread().sessionId).not.toBe('session-1');
    expect(leafSession(workspace)).toBe(thread().sessionId);
  });

  // The conversation being replaced is the one still being written.
  it('refuses to clear while a turn is running', async () => {
    await workspaceWith();
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    agentStore.useAgentStore.getState().startNewSession(PANE, '/repo');

    expect(thread().sessionId).toBe('session-1');
    expect(thread().messages).toHaveLength(2);
  });

  it('replaces the transcript with the session being resumed', async () => {
    const workspace = await workspaceWith();
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId: liveStreamId(), usage: null });
    replay = {
      messages: [textMessage('x', 'user', 'the old question')],
      contextTokens: 900,
      cwd: '/repo',
      title: 'Older work',
      firstUserText: '',
      skipped: 0
    };

    await agentStore.useAgentStore.getState().resumeSession(PANE, '/repo', OTHER);

    expect(thread().messages.map((m) => m.id)).toEqual(['x']);
    expect(thread().sessionId).toBe(OTHER);
    expect(leafSession(workspace)).toBe(OTHER);
  });

  it('refuses to resume while a turn is running', async () => {
    await workspaceWith();
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    await agentStore.useAgentStore.getState().resumeSession(PANE, '/repo', OTHER);

    expect(thread().sessionId).toBe('session-1');
  });

  /*
   * Two resumes in a row, the first one slower than the second. What the first
   * read carries belongs to a conversation the pane has already left, and
   * letting it land would show one session's history under another's name.
   */
  it('drops a load the pane has already moved on from', async () => {
    await workspaceWith();
    await agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');
    replay = {
      messages: [textMessage('slow', 'user', 'from the abandoned session')],
      contextTokens: null,
      cwd: '/repo',
      title: null,
      firstUserText: '',
      skipped: 0
    };

    const first = agentStore.useAgentStore.getState().resumeSession(PANE, '/repo', OTHER);
    // Arrives while the read above is still outstanding.
    agentStore.useAgentStore.getState().startNewSession(PANE, '/repo');
    await first;

    expect(thread().sessionId).not.toBe(OTHER);
    expect(thread().messages).toEqual([]);
  });

  /*
   * A fresh session has no file to read, so nothing would ever arrive to say
   * the wait is over. Clearing out of a session still loading has to leave a
   * pane that can be typed in.
   */
  it('leaves a cleared pane able to send, even mid-read', async () => {
    await workspaceWith();
    // A read that never comes back, which is what "still loading" is.
    Object.assign(window.fleet.agent, {
      loadSession: vi.fn().mockReturnValue(new Promise<AgentSessionReplay>(() => undefined))
    });
    void agentStore.useAgentStore.getState().openSession(PANE, 'session-1', '/repo');

    agentStore.useAgentStore.getState().startNewSession(PANE, '/repo');
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'hello');

    expect(thread().messages.map((m) => messageText(m))).toContain('hello');
  });
});

/**
 * A session is named once, after the turn that makes it a conversation, and
 * the name is written against the session that asked rather than whatever the
 * pane is showing when it arrives.
 */
describe('naming a session', () => {
  const open = async (sessionId = 'session-1'): Promise<void> => {
    await agentStore.useAgentStore.getState().openSession(PANE, sessionId, '/repo');
  };

  const titles = (): AgentSessionEvent[] =>
    agentApi.appendSession.mock.calls
      .map(([req]) => (req as AgentSessionAppend).event)
      .filter((e) => e.t === 'title');

  it('asks for a name after the first turn, and writes what comes back', async () => {
    agentApi.generateTitle.mockResolvedValueOnce('Slow parser');
    await open();
    turn('why is the parser slow');
    await vi.waitFor(() => expect(titles()).toHaveLength(1));

    expect(agentApi.generateTitle).toHaveBeenCalledWith({
      firstUser: 'why is the parser slow',
      firstAssistant: 'reply to why is the parser slow'
    });
    expect(titles()[0]).toEqual({ t: 'title', title: 'Slow parser' });
  });

  // Nothing records that a session has been named. The condition is that the
  // session holds one user message, which is true after exactly one turn.
  it('does not ask again on later turns', async () => {
    await open();
    turn('first');
    turn('second');
    turn('third');

    expect(agentApi.generateTitle).toHaveBeenCalledTimes(1);
  });

  it('does not name a session resumed with a conversation already in it', async () => {
    replay = {
      messages: [textMessage('a', 'user', 'earlier'), textMessage('b', 'assistant', 'answer')],
      contextTokens: null,
      cwd: '/repo',
      title: null,
      firstUserText: '',
      skipped: 0
    };
    await open();
    turn('carry on');

    expect(agentApi.generateTitle).not.toHaveBeenCalled();
  });

  it('writes nothing when no name came back', async () => {
    agentApi.generateTitle.mockResolvedValueOnce(null);
    await open();
    turn('hello');
    await vi.waitFor(() => expect(agentApi.generateTitle).toHaveBeenCalled());

    expect(titles()).toEqual([]);
  });

  /*
   * The one race this design exists to avoid: a name arriving after the pane
   * has cleared must land in the file that asked for it, not in the new one.
   */
  it('writes the name into the session that asked, not the one on screen now', async () => {
    let deliver: (title: string | null) => void = () => undefined;
    agentApi.generateTitle.mockReturnValueOnce(
      new Promise<string | null>((resolve) => {
        deliver = resolve;
      })
    );
    await open('session-1');
    turn('the first question');

    agentStore.useAgentStore.getState().startNewSession(PANE, '/repo');
    const cleared = thread().sessionId;
    deliver('First question');
    await vi.waitFor(() => expect(titles()).toHaveLength(1));

    const written = agentApi.appendSession.mock.calls
      .map(([req]) => req as AgentSessionAppend)
      .filter((req) => req.event.t === 'title');
    expect(written[0].sessionId).toBe('session-1');
    expect(written[0].sessionId).not.toBe(cleared);
  });
});
