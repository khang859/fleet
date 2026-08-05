import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { DEFAULT_AGENT_SETTINGS, type AgentSendRequest } from '../../../shared/agent-types';
import { AgentService, toReasoningParam, toWireMessages } from '../agent-service';
import { parseStreamLine, type StreamRequest } from '../openrouter';

const REQUEST: AgentSendRequest = {
  streamId: 'stream-1',
  cwd: '/repo',
  history: [
    { id: 'a', role: 'user', content: 'hi', reasoning: '' },
    { id: 'b', role: 'assistant', content: 'hello', reasoning: 'thinking' }
  ],
  text: 'what does this do?'
};

const SETTINGS = {
  ...DEFAULT_AGENT_SETTINGS,
  coding: { ...DEFAULT_AGENT_SETTINGS.coding, model: 'anthropic/claude-sonnet-4.5' }
};

/** Collects emitted events and resolves once the turn has ended. */
function collector(): {
  emit: (channel: string, payload: unknown) => void;
  events: Array<{ channel: string; payload: unknown }>;
  ended: Promise<void>;
} {
  const events: Array<{ channel: string; payload: unknown }> = [];
  let finish = (): void => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    events,
    ended,
    emit: (channel, payload) => {
      events.push({ channel, payload });
      if (
        channel === IPC_CHANNELS.AGENT_STREAM_DONE ||
        channel === IPC_CHANNELS.AGENT_STREAM_ERROR
      ) {
        finish();
      }
    }
  };
}

describe('parseStreamLine', () => {
  it('reads content and reasoning deltas', () => {
    expect(parseStreamLine('data: {"choices":[{"delta":{"content":"he"}}]}')).toEqual({
      content: 'he',
      reasoning: ''
    });
    expect(parseStreamLine('data: {"choices":[{"delta":{"reasoning":"hm"}}]}')).toEqual({
      content: '',
      reasoning: 'hm'
    });
  });

  it('recognises the end of the stream', () => {
    expect(parseStreamLine('data: [DONE]')).toBe('done');
  });

  it('ignores keep-alives, blank lines and anything unparseable', () => {
    // OpenRouter interleaves comment lines while the upstream model warms up.
    expect(parseStreamLine(': OPENROUTER PROCESSING')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('event: message')).toBeNull();
    expect(parseStreamLine('data: {not json')).toBeNull();
    expect(parseStreamLine('data: {"choices":[]}')).toBeNull();
  });
});

describe('toReasoningParam', () => {
  const base = DEFAULT_AGENT_SETTINGS.coding;

  it('is absent when nothing is set, so the model default applies', () => {
    expect(toReasoningParam(base)).toBeNull();
  });

  it('sends the one form the user configured, most specific first', () => {
    expect(toReasoningParam({ ...base, reasoningEnabled: true })).toEqual({ enabled: true });
    expect(toReasoningParam({ ...base, reasoningEnabled: true, reasoningEffort: 'high' })).toEqual({
      effort: 'high'
    });
    expect(
      toReasoningParam({
        ...base,
        reasoningEnabled: true,
        reasoningEffort: 'high',
        reasoningTokens: 4096
      })
    ).toEqual({ max_tokens: 4096 });
  });
});

describe('toWireMessages', () => {
  it('puts a system prompt naming the folder ahead of the transcript', () => {
    const messages = toWireMessages(REQUEST);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('/repo');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'what does this do?' }
    ]);
  });
});

describe('AgentService', () => {
  it('streams deltas out on their own channels and ends with done', async () => {
    const { emit, events, ended } = collector();
    const stream = vi.fn(async (req: StreamRequest) => {
      req.onReasoning('thinking');
      req.onDelta('an ');
      req.onDelta('answer');
      return Promise.resolve();
    });

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_STREAM_REASONING,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
    expect(events[1].payload).toEqual({ streamId: 'stream-1', delta: 'an ' });
  });

  it('passes the configured model and inference settings through', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve());

    new AgentService({
      getSettings: () => ({
        ...SETTINGS,
        coding: { ...SETTINGS.coding, maxTokens: 8192, temperature: 0.2, reasoningEffort: 'high' }
      }),
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-sonnet-4.5',
        maxTokens: 8192,
        temperature: 0.2,
        reasoning: { effort: 'high' }
      })
    );
  });

  it('reports a missing key as a stream error rather than throwing', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => null,
      emit,
      stream: vi.fn()
    }).send(REQUEST);
    await ended;

    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_ERROR,
        payload: { streamId: 'stream-1', message: 'No OpenRouter API key configured' }
      }
    ]);
  });

  it('reports a missing model the same way', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      getSettings: () => ({ ...SETTINGS, coding: { ...SETTINGS.coding, model: null } }),
      getApiKey: () => 'sk-or-test',
      emit,
      stream: vi.fn()
    }).send({ ...REQUEST, streamId: 'stream-2' });
    await ended;

    expect(events[0].payload).toEqual({
      streamId: 'stream-2',
      message: 'No coding model selected'
    });
  });

  it('treats a cancel as a normal ending, keeping the partial reply', async () => {
    const { emit, events, ended } = collector();
    const service = new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('half');
        service.cancel('stream-1');
        await Promise.resolve();
        // Whatever fetch would have thrown once aborted.
        throw new Error('The operation was aborted.');
      }
    });

    service.send(REQUEST);
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
  });
});
