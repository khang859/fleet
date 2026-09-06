import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  streamCompletion,
  withCacheBreakpoints,
  type AgentWireMessage,
  type CompletionsTarget
} from '../completions';
import { openRouterTarget } from '../openrouter';
import { DEFAULT_AGENT_CACHE, DEFAULT_AGENT_PROVIDER } from '../../../shared/agent-routing';

/**
 * What routing, fallbacks and caching put on the wire - and, mostly, what they
 * do not.
 *
 * The acceptance criterion these exist for is negative: a configuration nobody
 * has touched must produce the request Fleet has always sent, and a local
 * endpoint must not see any of this whatever the settings say. A regression
 * here is silent - the request still works, it just goes somewhere the user
 * did not choose, or fails on a server that cannot parse a field.
 */

const LOCAL: CompletionsTarget = {
  baseUrl: 'http://127.0.0.1:11437/v1',
  apiKey: null,
  extraHeaders: {},
  requestUsage: true,
  reasoningDialect: 'chat-template-kwargs',
  serverTools: false,
  label: '127.0.0.1:11437'
};

type Sent = { body: Record<string, unknown> };

function streaming(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push({ body: JSON.parse(init.body) as Sent['body'] });
      return Promise.resolve(new Response('data: [DONE]\n\n', { status: 200 }));
    })
  );
  return sent;
}

const base = {
  model: 'anthropic/claude-sonnet-4.5',
  messages: [] as AgentWireMessage[],
  maxTokens: null,
  temperature: null,
  reasoning: null,
  signal: new AbortController().signal,
  onDelta: () => {},
  onReasoning: () => {}
};

const HISTORY: AgentWireMessage[] = [
  { role: 'system', content: 'you are an agent' },
  { role: 'user', content: 'hello' }
];

/** One tool call, so a round can end the way most rounds actually end. */
const CALL = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'read', arguments: '{}' }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a request nobody has configured', () => {
  it('is the request Fleet has always sent', async () => {
    const sent = streaming();
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      messages: HISTORY,
      routing: DEFAULT_AGENT_PROVIDER,
      fallback: { models: [] }
    });
    expect(sent[0]?.body).not.toHaveProperty('provider');
    expect(sent[0]?.body).not.toHaveProperty('models');
  });
});

describe('a local endpoint', () => {
  /*
   * A `llama-server` is the provider. A `provider` key is at best ignored and
   * at worst a 400 on a body it cannot parse.
   */
  it('never sees routing preferences, whatever the settings say', async () => {
    const sent = streaming();
    await streamCompletion({
      ...base,
      target: LOCAL,
      messages: HISTORY,
      routing: { ...DEFAULT_AGENT_PROVIDER, sort: 'price', ignore: ['anthropic'] },
      fallback: { models: ['openai/gpt-5.1'] }
    });
    expect(sent[0]?.body).not.toHaveProperty('provider');
    expect(sent[0]?.body).not.toHaveProperty('models');
  });

  /*
   * And its messages stay strings. Turning every system prompt into a
   * one-element array for a server that cannot read the marker would be a
   * change to every request for no gain at all.
   */
  it('gets its messages unchanged, with no cache markers', async () => {
    const sent = streaming();
    await streamCompletion({
      ...base,
      target: LOCAL,
      messages: HISTORY,
      cache: DEFAULT_AGENT_CACHE
    });
    expect(sent[0]?.body.messages).toEqual(HISTORY);
  });
});

describe('a configured request', () => {
  it('carries the routing preferences under provider', async () => {
    const sent = streaming();
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      messages: HISTORY,
      routing: { ...DEFAULT_AGENT_PROVIDER, sort: 'latency', order: ['together'] }
    });
    expect(sent[0]?.body.provider).toEqual({ order: ['together'], sort: 'latency' });
  });

  it('carries the fallback route with the chosen model at its head', async () => {
    const sent = streaming();
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      messages: HISTORY,
      fallback: { models: ['openai/gpt-5.1'] }
    });
    expect(sent[0]?.body.models).toEqual(['anthropic/claude-sonnet-4.5', 'openai/gpt-5.1']);
    // The primary still goes in `model`; `models` is the whole route, not a
    // replacement for it.
    expect(sent[0]?.body.model).toBe('anthropic/claude-sonnet-4.5');
  });
});

describe('where the cache breakpoints go', () => {
  /*
   * The system prompt is the same text on every round of every turn, and it is
   * the largest fixed cost Fleet has.
   */
  it('marks the system prompt', () => {
    const marked = withCacheBreakpoints(HISTORY, DEFAULT_AGENT_CACHE);
    expect(marked[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'you are an agent', cache_control: { type: 'ephemeral' } }]
    });
  });

  /*
   * And the end of the request, which is what makes an agent loop cheap: round
   * five's request is round four's plus a delta, so everything before the mark
   * is read back rather than paid for again.
   */
  it('marks the last message so the next round reads the whole prefix back', () => {
    const marked = withCacheBreakpoints(HISTORY, DEFAULT_AGENT_CACHE);
    expect(marked[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]
    });
  });

  /*
   * `runRounds` keeps one array across rounds and appends to it. A marker
   * written into it would still be there next round, and one more each round
   * after that.
   */
  it('copies rather than marking in place', () => {
    const original: AgentWireMessage[] = [{ role: 'system', content: 'p' }];
    withCacheBreakpoints(original, DEFAULT_AGENT_CACHE);
    expect(original[0]).toEqual({ role: 'system', content: 'p' });
  });

  it('leaves everything alone when caching is off', () => {
    expect(withCacheBreakpoints(HISTORY, { enabled: false, longTtl: false })).toBe(HISTORY);
  });

  /*
   * A marker means "up to here", so on the first of two parts it would cache
   * less than the message. And it cannot ride on a picture at all.
   */
  it('marks the last text part of a message that carries a picture', () => {
    const marked = withCacheBreakpoints(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
          ]
        }
      ],
      DEFAULT_AGENT_CACHE
    );
    expect(marked[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look', cache_control: { type: 'ephemeral' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }
      ]
    });
  });

  /*
   * The ordinary shape of a round, and the one this feature exists for. A round
   * that asked for tools ends on their output, which is most rounds of most
   * turns - so if the marker stops at the system message here, every file the
   * turn has read is paid for again on the next round.
   *
   * A tool result carries the marker as a content part, which Anthropic accepts
   * and acts on: a 14,000-token result marked this way reports 14,673 cache
   * write tokens where the same request marked only on the system message
   * reports zero.
   */
  it('marks the tool result the round ended on', () => {
    const messages: AgentWireMessage[] = [
      { role: 'system', content: 'p' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', tool_calls: [CALL] },
      { role: 'tool', tool_call_id: 'call_1', content: 'the whole file' }
    ];
    const marked = withCacheBreakpoints(messages, DEFAULT_AGENT_CACHE);
    expect(marked[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ type: 'text', text: 'the whole file', cache_control: { type: 'ephemeral' } }]
    });
  });

  /* The user message in the middle is not the end of anything. */
  it('marks only the system prompt and the end, not every user message', () => {
    const messages: AgentWireMessage[] = [
      { role: 'system', content: 'p' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', tool_calls: [CALL] },
      { role: 'tool', tool_call_id: 'call_1', content: 'the whole file' }
    ];
    const marked = withCacheBreakpoints(messages, DEFAULT_AGENT_CACHE);
    expect(marked[1]).toEqual(messages[1]);
    expect(marked[2]).toEqual(messages[2]);
  });

  /* Two markers, which is well inside Anthropic's four. */
  it('never writes more than two', () => {
    const messages: AgentWireMessage[] = [
      { role: 'system', content: 'p' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: '', tool_calls: [CALL] },
      { role: 'tool', tool_call_id: 'call_1', content: 'four' }
    ];
    const marked = withCacheBreakpoints(messages, DEFAULT_AGENT_CACHE);
    const markers = JSON.stringify(marked).split('cache_control').length - 1;
    expect(markers).toBe(2);
  });

  it('asks for the hour when told to', () => {
    const marked = withCacheBreakpoints(HISTORY, { enabled: true, longTtl: true });
    expect(marked[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'you are an agent', cache_control: { type: 'ephemeral', ttl: '1h' } }
      ]
    });
  });
});
