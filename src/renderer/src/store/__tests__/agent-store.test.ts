import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { DEFAULT_SETTINGS } from '../../../../shared/constants';
import type { AgentCatalogModel, AgentUsage } from '../../../../shared/agent-types';
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
  cancel: vi.fn()
};

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

  Object.assign(window.fleet, {
    agent: {
      listModels: vi
        .fn()
        .mockResolvedValue({ models: [catalogModel], fetchedAt: 1, source: 'cache', error: null }),
      send: agentApi.send,
      compact: agentApi.compact,
      cancel: agentApi.cancel,
      onStreamChunk: listen(IPC_CHANNELS.AGENT_STREAM_CHUNK),
      onStreamReasoning: listen(IPC_CHANNELS.AGENT_STREAM_REASONING),
      onStreamDone: listen(IPC_CHANNELS.AGENT_STREAM_DONE),
      onStreamError: listen(IPC_CHANNELS.AGENT_STREAM_ERROR),
      onCompactDone: listen(IPC_CHANNELS.AGENT_COMPACT_DONE)
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
