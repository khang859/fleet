import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import type { AgentCatalogModel, AgentMessage, AgentUsage } from '../../../../shared/agent-types';
import type {
  AgentSessionAppend,
  AgentSessionEvent,
  AgentSessionReplay
} from '../../../../shared/agent-session';
import type * as AgentStore from '../agent-store';
import type * as SettingsStore from '../settings-store';

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
const agentApi = {
  send: vi.fn(),
  compact: vi.fn(),
  cancel: vi.fn(),
  appendSession: vi.fn()
};

/** What `loadSession` hands back; set per test to stand in for a file. */
let replay: AgentSessionReplay;

// Loaded per test rather than at the top: the store installs its IPC listeners
// on import, so the bridge has to exist first.
let agentStore: typeof AgentStore;
let settingsStore: typeof SettingsStore;

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
  replay = { messages: [], contextTokens: null, cwd: null, skipped: 0 };

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
      onStreamChunk: listen(IPC_CHANNELS.AGENT_STREAM_CHUNK),
      onStreamReasoning: listen(IPC_CHANNELS.AGENT_STREAM_REASONING),
      onStreamDone: listen(IPC_CHANNELS.AGENT_STREAM_DONE),
      onStreamError: listen(IPC_CHANNELS.AGENT_STREAM_ERROR),
      onCompactDone: listen(IPC_CHANNELS.AGENT_COMPACT_DONE),
      onToolStart: listen(IPC_CHANNELS.AGENT_TOOL_START),
      onToolEnd: listen(IPC_CHANNELS.AGENT_TOOL_END)
    },
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
    expect(req.messages[0].content).toBe('one');
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
    expect(messages[0]).toMatchObject({ role: 'summary', content: 'They chose zod over casts.' });
    expect(messages.slice(1).map((m) => m.content)).toEqual([
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

    expect(written()).toEqual([
      { t: 'message', message: expect.objectContaining({ role: 'user', content: 'hello' }) }
    ]);
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
        message: expect.objectContaining({ role: 'assistant', content: 'hi there' })
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
      message: expect.objectContaining({ content: 'half an ans' })
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
      summary: expect.objectContaining({ role: 'summary', content: 'we talked about one' }),
      keep: keptIds
    });
  });

  it('replays a session into the thread when the pane opens', async () => {
    replay = {
      messages: [
        {
          id: 'a',
          role: 'user',
          content: 'earlier',
          reasoning: '',
          reasoningMs: null,
          toolCalls: []
        },
        {
          id: 'b',
          role: 'assistant',
          content: 'answer',
          reasoning: '',
          reasoningMs: null,
          toolCalls: []
        }
      ],
      contextTokens: 4_000,
      cwd: '/repo',
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

    expect(thread().messages.at(-1)?.toolCalls).toEqual([CALL]);
  });

  // The same call twice, not two calls: the row on screen fills in rather than
  // being joined by a second copy of itself.
  it('replaces the call in place when it finishes', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'what is in a.ts?');
    const streamId = liveStreamId();
    start(streamId);
    finish(streamId);

    expect(thread().messages.at(-1)?.toolCalls).toEqual([
      { ...CALL, result: 'a.ts lines 1-1', summary: '1 line' }
    ]);
  });

  it('keeps two calls in the order they were made', () => {
    agentStore.useAgentStore.getState().send(PANE, '/repo', 'look around');
    const streamId = liveStreamId();
    start(streamId);
    emit(IPC_CHANNELS.AGENT_TOOL_START, {
      streamId,
      call: { ...CALL, id: 'call_2', name: 'glob' }
    });

    expect(
      thread()
        .messages.at(-1)
        ?.toolCalls.map((c) => c.name)
    ).toEqual(['read', 'glob']);
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
        content: '',
        toolCalls: [expect.objectContaining({ summary: '1 line' })]
      })
    });
  });
});
