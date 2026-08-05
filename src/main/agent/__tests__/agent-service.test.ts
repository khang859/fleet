import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import {
  buildSystemPrompt,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  type AgentCompactRequest,
  type AgentSendRequest
} from '../../../shared/agent-types';
import { COMPACT_SYSTEM_PROMPT, SUMMARY_WIRE_PREFIX } from '../../../shared/agent-context';
import { AgentService, toCompactMessages, toReasoningParam, toWireHistory } from '../agent-service';
import {
  collectToolCalls,
  parseStreamLine,
  type StreamOutcome,
  type StreamRequest,
  type ToolCallDelta,
  type WireToolCall
} from '../openrouter';

const REQUEST: AgentSendRequest = {
  streamId: 'stream-1',
  cwd: '/repo',
  history: [
    { id: 'a', role: 'user', content: 'hi', reasoning: '', reasoningMs: null, toolCalls: [] },
    {
      id: 'b',
      role: 'assistant',
      content: 'hello',
      reasoning: 'thinking',
      reasoningMs: 1200,
      toolCalls: []
    }
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
      toolCalls: [],
      usage: null
    });
    expect(parseStreamLine('data: {"choices":[{"delta":{"reasoning":"hm"}}]}')).toEqual({
      content: '',
      reasoning: 'hm',
      toolCalls: [],
      usage: null
    });
  });

  it('reads the token usage the last message carries', () => {
    const usage = '"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196}';

    expect(parseStreamLine(`data: {"choices":[{"delta":{"content":""}}],${usage}}`)).toEqual({
      content: '',
      reasoning: '',
      toolCalls: [],
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
      toolCalls: [],
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

describe('toWireHistory', () => {
  it('puts the system prompt ahead of the transcript', () => {
    const messages = toWireHistory(REQUEST, 'be brief');

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
      reasoningMs: null,
      toolCalls: []
    };
    const messages = toWireHistory({ ...REQUEST, history: [summary] }, 'be brief');

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
      return Promise.resolve({ toolCalls: [] });
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
    const stream = vi.fn(async () => Promise.resolve({ toolCalls: [] }));

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
    const stream = vi.fn(async () => Promise.resolve({ toolCalls: [] }));

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
        return Promise.resolve({ toolCalls: [] });
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
      stream: vi.fn(async () => Promise.resolve({ toolCalls: [] }))
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
        return Promise.resolve({ toolCalls: [] });
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
    const stream = vi.fn(async () => Promise.resolve({ toolCalls: [] }));

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
        return Promise.resolve({ toolCalls: [] });
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

describe('collectToolCalls', () => {
  const frag = (
    index: number,
    over: Partial<{ id: string | null; name: string | null; args: string }> = {}
  ): ToolCallDelta => ({ index, id: null, name: null, args: '', ...over });

  it('reassembles a call streamed a few characters at a time', () => {
    const calls = collectToolCalls([
      frag(0, { id: 'call_1', name: 'read' }),
      frag(0, { args: '{"path":' }),
      frag(0, { args: '"a.ts"}' })
    ]);

    expect(calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }
    ]);
  });

  it('keeps two calls apart by their index, in the order asked for', () => {
    const calls = collectToolCalls([
      frag(0, { id: 'a', name: 'grep' }),
      frag(1, { id: 'b', name: 'glob' }),
      frag(1, { args: '{"pattern":"*.ts"}' }),
      frag(0, { args: '{"pattern":"x"}' })
    ]);

    expect(calls.map((c) => c.function.name)).toEqual(['grep', 'glob']);
    expect(calls[1].function.arguments).toBe('{"pattern":"*.ts"}');
  });

  it('gives a call an id when the provider streamed none', () => {
    expect(collectToolCalls([frag(0, { name: 'read', args: '{}' })])[0].id).toBe('call_0');
  });

  it('ignores a fragment that never named a tool', () => {
    expect(collectToolCalls([frag(0, { args: '{}' })])).toEqual([]);
  });
});

describe('the tool loop', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-agent-loop-'));
    writeFileSync(join(dir, 'answer.txt'), 'the answer is 42');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: object): WireToolCall => ({
    id: 'call_1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  });

  /** A stream that asks for `calls` on its first round and answers on its second. */
  function twoRounds(calls: WireToolCall[]): {
    stream: (req: StreamRequest) => Promise<StreamOutcome>;
    rounds: StreamRequest[];
  } {
    const rounds: StreamRequest[] = [];
    return {
      rounds,
      stream: async (req) => {
        rounds.push(req);
        if (rounds.length === 1) return Promise.resolve({ toolCalls: calls });
        req.onDelta('42');
        return Promise.resolve({ toolCalls: [] });
      }
    };
  }

  it('runs what the model asked for and sends the result back', async () => {
    const { emit, ended } = collector();
    const { stream, rounds } = twoRounds([call('read', { path: 'answer.txt' })]);

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    // The second round sees its own request and the answer to it.
    const sent = rounds[1].messages;
    expect(sent.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'read' } }]
    });
    expect(sent.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(sent.at(-1)).toHaveProperty('content', expect.stringContaining('the answer is 42'));
  });

  it('tells the pane a call started and how it ended', async () => {
    const { emit, events, ended } = collector();
    const { stream } = twoRounds([call('read', { path: 'answer.txt' })]);

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(events.map((e) => e.channel)).toEqual([
      IPC_CHANNELS.AGENT_TOOL_START,
      IPC_CHANNELS.AGENT_TOOL_END,
      IPC_CHANNELS.AGENT_STREAM_CHUNK,
      IPC_CHANNELS.AGENT_STREAM_DONE
    ]);
    expect(events[0].payload).toMatchObject({
      call: { id: 'call_1', name: 'read', result: null, summary: null }
    });
    expect(events[1].payload).toMatchObject({ call: { summary: '1 line', error: null } });
  });

  // The failure that must not end the turn: the model asked for something it
  // cannot have, and the only way it can fix that is by being told.
  it('hands a refused call back to the model as its result', async () => {
    const { emit, events, ended } = collector();
    const { stream, rounds } = twoRounds([call('read', { path: '../../../etc/passwd' })]);

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(rounds[1].messages.at(-1)).toHaveProperty(
      'content',
      expect.stringContaining('outside the working folder')
    );
    expect(events.at(-1)?.channel).toBe(IPC_CHANNELS.AGENT_STREAM_DONE);
    const end = events.find((e) => e.channel === IPC_CHANNELS.AGENT_TOOL_END);
    expect(end?.payload).toMatchObject({ call: { summary: 'failed' } });
  });

  it('offers the tools to the model', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async () => Promise.resolve({ toolCalls: [] }));

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })
        ])
      })
    );
  });

  // The loop this cannot have: a model that keeps calling tools forever costs
  // money on every lap.
  it('stops after a fixed number of rounds', async () => {
    const { emit, events, ended } = collector();
    const stream = vi.fn(async () =>
      Promise.resolve({ toolCalls: [call('read', { path: 'answer.txt' })] })
    );

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).send({ ...REQUEST, cwd: dir });
    await ended;

    expect(stream).toHaveBeenCalledTimes(12);
    expect(events.at(-1)?.channel).toBe(IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(events.at(-1)?.payload).toMatchObject({ message: expect.stringContaining('12 rounds') });
  });

  it('does not offer tools when summarizing', async () => {
    const { emit, ended } = collector();
    const stream = vi.fn(async (req: StreamRequest) => {
      req.onDelta('a summary');
      return Promise.resolve({ toolCalls: [] });
    });

    new AgentService({
      getSettings: () => SETTINGS,
      getApiKey: () => 'sk-or-test',
      emit,
      stream
    }).compact(COMPACT_REQUEST);
    await ended;

    expect(stream.mock.calls[0][0].tools).toBeUndefined();
  });
});
