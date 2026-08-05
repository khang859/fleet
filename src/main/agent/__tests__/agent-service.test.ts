import { describe, it, expect, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  buildSystemPrompt,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  type AgentCompactRequest,
  type AgentSendRequest
} from '../../../shared/agent-types';
import { COMPACT_SYSTEM_PROMPT, SUMMARY_WIRE_PREFIX } from '../../../shared/agent-context';
import {
  AgentService,
  toCompactMessages,
  toReasoningParam,
  toWireMessages
} from '../agent-service';
import { parseStreamLine, type StreamRequest } from '../openrouter';

const REQUEST: AgentSendRequest = {
  streamId: 'stream-1',
  cwd: '/repo',
  history: [
    { id: 'a', role: 'user', content: 'hi', reasoning: '', reasoningMs: null },
    { id: 'b', role: 'assistant', content: 'hello', reasoning: 'thinking', reasoningMs: 1200 }
  ],
  text: 'what does this do?'
};

const COMPACT_REQUEST: AgentCompactRequest = {
  streamId: 'compact-1',
  cwd: '/repo',
  messages: REQUEST.history
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
        channel === IPC_CHANNELS.AGENT_STREAM_ERROR ||
        channel === IPC_CHANNELS.AGENT_COMPACT_DONE
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
      reasoning: '',
      usage: null
    });
    expect(parseStreamLine('data: {"choices":[{"delta":{"reasoning":"hm"}}]}')).toEqual({
      content: '',
      reasoning: 'hm',
      usage: null
    });
  });

  it('reads the token usage the last message carries', () => {
    const usage = '"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196}';

    expect(parseStreamLine(`data: {"choices":[{"delta":{"content":""}}],${usage}}`)).toEqual({
      content: '',
      reasoning: '',
      usage: { promptTokens: 194, completionTokens: 2, totalTokens: 196 }
    });
  });

  it('still reads usage from a final message that carries no delta', () => {
    // Some upstreams send the usage on a message with an empty choices array,
    // which would otherwise be discarded along with the keep-alives.
    expect(
      parseStreamLine(
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}'
      )
    ).toEqual({
      content: '',
      reasoning: '',
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }
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

describe('buildSystemPrompt', () => {
  it('uses the built-in instructions, which ask for Markdown', () => {
    const prompt = buildSystemPrompt('/repo', null);

    expect(prompt).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(prompt).toContain('Markdown');
  });

  it('replaces the instructions with the user override', () => {
    const prompt = buildSystemPrompt('/repo', 'Answer only in haiku.');

    expect(prompt).toContain('Answer only in haiku.');
    expect(prompt).not.toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
  });

  it('keeps the working folder whatever the prompt says', () => {
    expect(buildSystemPrompt('/repo', null)).toContain('/repo');
    expect(buildSystemPrompt('/repo', 'Answer only in haiku.')).toContain('/repo');
  });

  it('treats a blank override as no override, so the field can be cleared', () => {
    expect(buildSystemPrompt('/repo', '   \n ')).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
  });
});

describe('toWireMessages', () => {
  it('puts the system prompt ahead of the transcript', () => {
    const messages = toWireMessages(REQUEST, 'be brief');

    expect(messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'what does this do?' }
    ]);
  });

  it('sends a summary as a labelled user message, not as the assistant speaking', () => {
    const summary = {
      id: 's',
      role: 'summary' as const,
      content: 'we chose zod',
      reasoning: '',
      reasoningMs: null
    };
    const messages = toWireMessages({ ...REQUEST, history: [summary] }, 'be brief');

    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(SUMMARY_WIRE_PREFIX);
    expect(messages[1].content).toContain('we chose zod');
  });
});

describe('toCompactMessages', () => {
  it('hands the messages over as a transcript under the compaction instructions', () => {
    const messages = toCompactMessages(COMPACT_REQUEST);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(COMPACT_SYSTEM_PROMPT);
    expect(messages[0].content).toContain('/repo');
    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]);
    // Ends on a user turn: a transcript that stops on an assistant message is
    // an invalid request for some providers.
    expect(messages.at(-1)?.role).toBe('user');
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

  it('sends the configured system prompt instead of the default', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve());

    new AgentService({
      getSettings: () => ({ ...SETTINGS, systemPrompt: 'Answer only in haiku.' }),
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send(REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            role: 'system',
            // The override, then the folder Fleet always appends.
            content: expect.stringMatching(/Answer only in haiku[\s\S]*\/repo/)
          }
        ])
      })
    );
  });

  it('reports the token usage the provider counted, so context can be measured', async () => {
    const { emit, events, ended } = collector();
    const usage = { promptTokens: 900, completionTokens: 100, totalTokens: 1000 };

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('an answer');
        req.onUsage?.(usage);
        return Promise.resolve();
      }
    }).send(REQUEST);
    await ended;

    expect(events.at(-1)).toEqual({
      channel: IPC_CHANNELS.AGENT_STREAM_DONE,
      payload: { streamId: 'stream-1', usage }
    });
  });

  it('reports no usage rather than a zero when the provider sends none', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: vi.fn(async () => Promise.resolve())
    }).send(REQUEST);
    await ended;

    expect(events.at(-1)?.payload).toEqual({ streamId: 'stream-1', usage: null });
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

  it('compacts by returning the finished summary in one piece', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('  They chose zod ');
        req.onDelta('over casts.  ');
        req.onUsage?.({ promptTokens: 500, completionTokens: 20, totalTokens: 520 });
        return Promise.resolve();
      }
    }).compact(COMPACT_REQUEST);
    await ended;

    // Nothing streams to the pane: one event, carrying the whole summary.
    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_COMPACT_DONE,
        payload: {
          streamId: 'compact-1',
          summary: 'They chose zod over casts.',
          usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520 }
        }
      }
    ]);
  });

  it('does not spend the configured thinking budget on a summary', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve());

    new AgentService({
      getSettings: () => ({
        ...SETTINGS,
        coding: { ...SETTINGS.coding, reasoningEffort: 'high', maxTokens: 64_000 }
      }),
      getApiKey: () => 'sk-or-test',
      emit,
      // An empty stream fails the compaction, which is fine: the request has
      // already been made by then, and the request is what this asserts on.
      stream
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: null, maxTokens: 4096 })
    );
  });

  it('fails rather than replacing a transcript with an empty summary', async () => {
    const { emit, events, ended } = collector();

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async (req) => {
        req.onDelta('   \n ');
        return Promise.resolve();
      }
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_ERROR,
        payload: { streamId: 'compact-1', message: 'The model returned an empty summary' }
      }
    ]);
  });

  it('leaves the transcript alone when a compaction is cancelled', async () => {
    const { emit, events, ended } = collector();
    const service = new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream: async () => {
        service.cancel('compact-1');
        await Promise.resolve();
        throw new Error('The operation was aborted.');
      }
    });

    service.compact(COMPACT_REQUEST);
    await ended;

    // Ends on the ordinary done channel, with no summary to apply.
    expect(events).toEqual([
      {
        channel: IPC_CHANNELS.AGENT_STREAM_DONE,
        payload: { streamId: 'compact-1', usage: null }
      }
    ]);
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
