import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamResponse, toResponsesInput, toResponsesTool } from '../responses';
import { openRouterTarget } from '../openrouter';
import { forCompletionsWire, type AgentWireMessage } from '../completions';
import type { AgentUsage } from '../../../shared/agent-types';

/**
 * The Responses transport, against streams OpenRouter actually sent.
 *
 * The two fixtures are captured rather than written. That matters more here
 * than it usually does: this endpoint's event set is documented thinly, the
 * item shapes differ between the kinds of thing in one array, and a
 * hand-written fixture would only ever prove that the parser agrees with
 * whoever wrote the fixture. `responses-tool-search.sse` is a real round where
 * a deferred tool was found and called; `responses-history-replay.sse` is a
 * real round where a previous call and its result were sent back as history.
 *
 * The only edit made to either was shortening the encrypted reasoning blobs,
 * which this transport carries opaquely and never reads.
 */

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', `responses-${name}.sse`), 'utf8');
}

type Sent = { url: string; body: Record<string, unknown> };

/** Answers with a captured stream, capturing what was asked for. */
function replaying(sse: string): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Sent['body'] });
      return Promise.resolve(new Response(sse, { status: 200 }));
    })
  );
  return sent;
}

const base = {
  model: 'openai/gpt-5.1-codex-mini',
  messages: [],
  maxTokens: null,
  temperature: null,
  reasoning: null,
  signal: new AbortController().signal,
  onDelta: () => {},
  onReasoning: () => {}
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the request body', () => {
  it('posts to /responses rather than /chat/completions', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/responses');
  });

  /*
   * The saving is the whole point of this transport existing, and it is one
   * flag on one tool. A request that reached the wire without it would look
   * exactly like a working one and cost exactly what it costs today.
   */
  it('marks deferred tools and leaves the loaded ones alone', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: {} } }],
      deferredTools: [
        { type: 'function', function: { name: 'mcp_thing', description: 'x', parameters: {} } }
      ],
      serverTools: [{ type: 'openrouter:tool_search', parameters: { max_results: 5 } }]
    });
    expect(sent[0]?.body.tools).toEqual([
      { type: 'openrouter:tool_search', parameters: { max_results: 5 } },
      { type: 'function', name: 'read', description: 'r', parameters: {} },
      {
        type: 'function',
        name: 'mcp_thing',
        description: 'x',
        parameters: {},
        defer_loading: true
      }
    ]);
  });

  /*
   * With deferral active the API takes `tool_choice` only as `auto` or
   * `allowed_tools` and 400s on anything else. Fleet sends none, and this is
   * the test that keeps that a decision.
   */
  it('never sends tool_choice, and never stores the response', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(sent[0]?.body).not.toHaveProperty('tool_choice');
    expect(sent[0]?.body.store).toBe(false);
  });

  it('sends max_output_tokens rather than max_tokens', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({ ...base, target: openRouterTarget('sk-or-test'), maxTokens: 1000 });
    expect(sent[0]?.body.max_output_tokens).toBe(1000);
    expect(sent[0]?.body).not.toHaveProperty('max_tokens');
  });
});

describe('history, converted to input items', () => {
  it('turns a tool round trip into a call item and an output item', () => {
    expect(
      toResponsesInput([
        { role: 'user', content: 'find the files' },
        {
          role: 'assistant',
          content: 'Looking.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'glob', arguments: '{"p":"*"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'a.ts' }
      ])
    ).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find the files' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking.' }]
      },
      { type: 'function_call', call_id: 'call_1', name: 'glob', arguments: '{"p":"*"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' }
    ]);
  });

  /*
   * A turn that only asked for a tool has no text, and an empty message item is
   * rejected rather than ignored - so the round after any silent tool call
   * would fail outright.
   */
  it('omits the message item when the assistant only called a tool', () => {
    expect(
      toResponsesInput([
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'glob', arguments: '{}' } }
          ]
        }
      ])
    ).toEqual([{ type: 'function_call', call_id: 'call_1', name: 'glob', arguments: '{}' }]);
  });

  it('carries a picture as an input_image beside its text', () => {
    expect(
      toResponsesInput([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
          ]
        }
      ])
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
        ]
      }
    ]);
  });

  it('sends the system prompt as a message rather than as instructions', () => {
    expect(toResponsesInput([{ role: 'system', content: 'be brief' }])).toEqual([
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be brief' }] }
    ]);
  });
});

describe('a tool definition, flattened', () => {
  it('lifts the three fields out of the function key', () => {
    expect(
      toResponsesTool(
        {
          type: 'function',
          function: { name: 'read', description: 'reads', parameters: { a: 1 } }
        },
        false
      )
    ).toEqual({ type: 'function', name: 'read', description: 'reads', parameters: { a: 1 } });
  });
});

describe('a captured round where a deferred tool was found', () => {
  it('returns the call the model made after searching', async () => {
    replaying(fixture('tool-search'));
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(outcome.toolCalls).toEqual([
      {
        id: 'call_dpiOx0synYf3EeqAWcnlaCRB',
        type: 'function',
        function: { name: 'widget_registry_lookup', arguments: '{"serial":"ABC-123"}' }
      }
    ]);
  });

  /*
   * The search itself is OpenRouter's own work, already finished. It has to be
   * shown and counted, and it must never reach local dispatch - there is no
   * function called `openrouter:tool_search` for it to land on.
   */
  it('records the search as remote work rather than as something to run', async () => {
    replaying(fixture('tool-search'));
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(outcome.serverToolCalls).toHaveLength(1);
    expect(outcome.serverToolCalls[0]?.toolName).toBe('openrouter:tool_search');
    expect(outcome.serverToolCalls[0]?.args).toContain('widget');
    expect(outcome.toolCalls.map((c) => c.function.name)).not.toContain('openrouter:tool_search');
  });

  /* Reasoning items are neither a call nor remote work, and must be neither. */
  it('does not mistake a reasoning item for a server tool', async () => {
    replaying(fixture('tool-search'));
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(outcome.serverToolCalls.map((c) => c.toolName)).not.toContain('reasoning');
  });

  it("reports the usage from this endpoint's differently named counts", async () => {
    replaying(fixture('tool-search'));
    let usage: AgentUsage | null = null;
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onUsage: (u) => {
        usage = u;
      }
    });
    expect(usage).toMatchObject({
      promptTokens: 1865,
      completionTokens: 883,
      totalTokens: 2748,
      reasoningTokens: 768,
      serverToolCalls: 1
    });
  });

  it('names the model that served it', async () => {
    replaying(fixture('tool-search'));
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(outcome.model).toBe('openai/gpt-5.1-codex-mini');
  });
});

describe('a captured round replayed from history', () => {
  it('streams the answer as it arrives and returns no calls', async () => {
    replaying(fixture('history-replay'));
    let text = '';
    const outcome = await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onDelta: (delta) => {
        text += delta;
      }
    });
    expect(text).toContain('a.ts');
    expect(text).toContain('Done.');
    expect(outcome.toolCalls).toEqual([]);
    expect(outcome.serverToolCalls).toEqual([]);
  });
});

describe('when the round does not finish', () => {
  it('rejects with the message the stream reported', async () => {
    replaying('data: {"type":"error","error":{"message":"upstream is down"}}\n\n');
    await expect(
      streamResponse({ ...base, target: openRouterTarget('sk-or-test') })
    ).rejects.toThrow('upstream is down');
  });

  it('rejects rather than returning an empty answer when nothing terminal arrived', async () => {
    replaying('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
    await expect(
      streamResponse({ ...base, target: openRouterTarget('sk-or-test') })
    ).rejects.toThrow('ended without an answer');
  });

  /*
   * An incomplete round ran out of its token budget mid-answer. What it did
   * produce is real, and throwing it away would lose a partial answer the user
   * watched arrive.
   */
  it('keeps what an incomplete round produced', async () => {
    replaying(
      'data: {"type":"response.incomplete","response":{"model":"m","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"half"}]}]}}\n\n'
    );
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    expect(outcome.model).toBe('m');
    expect(outcome.toolCalls).toEqual([]);
  });
});

/*
 * The spend brake and the step ceiling, which used to stop existing the moment
 * deferral was switched on.
 *
 * `AgentService` builds the same conditions for both transports, and this one
 * simply never serialised them - so a turn with an MCP server connected ran
 * OpenRouter's loop under its defaults while the two settings sat on screen
 * saying otherwise. The endpoint does parse the field: an invented condition
 * type comes back 400 naming the five it knows.
 */
describe('stop conditions', () => {
  const stops = [
    { type: 'step_count_is' as const, step_count: 10 },
    { type: 'max_cost' as const, max_cost_in_dollars: 0.25 }
  ];
  const searchTool = { type: 'openrouter:tool_search', parameters: { max_results: 5 } };

  it('sends them when server tools went', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      serverTools: [searchTool],
      serverToolStops: stops
    });
    expect(sent[0]?.body.stop_server_tools_when).toEqual(stops);
  });

  /* On its own it is a rule about a loop that will never run. */
  it('leaves them off when no server tool went', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: {} } }],
      serverToolStops: stops
    });
    expect(sent[0]?.body).not.toHaveProperty('stop_server_tools_when');
  });

  it('leaves them off when there are none to send', async () => {
    const sent = replaying(fixture('history-replay'));
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      serverTools: [searchTool],
      serverToolStops: []
    });
    expect(sent[0]?.body).not.toHaveProperty('stop_server_tools_when');
  });
});

/*
 * What a finished round has to keep, and what happens to it on the way back.
 *
 * This API's history is items rather than messages, and two of them cannot be
 * rebuilt from an assistant message: a reasoning item carries an opaque
 * `encrypted_content` that is the model's own chain of thought, and a server
 * tool's item is what an advisor's memory of an earlier consultation is keyed
 * on. Rebuilding drops both, and the failure is silent - the model simply
 * starts thinking over each round and the advisor forgets it was ever asked.
 */
describe('carrying a round back to the next request', () => {
  /** The items a real deferred-tool round finished with. */
  async function finished(): Promise<Array<Record<string, unknown>>> {
    replaying(fixture('tool-search'));
    const outcome = await streamResponse({ ...base, target: openRouterTarget('sk-or-test') });
    return outcome.outputItems ?? [];
  }

  it('reports the items the round finished with', async () => {
    const items = await finished();

    expect(items.map((item) => item.type)).toContain('reasoning');
    expect(items.map((item) => item.type)).toContain('openrouter:tool_search');
  });

  /*
   * The parse used to be a narrowing one, which dropped every key it had not
   * been told about - which is most of what an item is. The keys it dropped
   * were exactly the ones a replay exists to hand back.
   */
  it('keeps the keys the schema was never told about', async () => {
    const items = await finished();
    const reasoning = items.find((item) => item.type === 'reasoning');

    expect(reasoning).toBeDefined();
    expect(reasoning).toHaveProperty('encrypted_content');
    expect(String(reasoning?.encrypted_content)).not.toBe('');
  });

  it('hands the items back byte for byte on the next request', async () => {
    const items = await finished();
    vi.unstubAllGlobals();
    const sent = replaying(fixture('history-replay'));
    await streamResponse({
      ...base,
      target: openRouterTarget('sk-or-test'),
      messages: [
        { role: 'user', content: 'find me a widget' },
        { role: 'assistant', content: 'looking', response_output: items }
      ]
    });

    const input = sent[0]?.body.input as Array<Record<string, unknown>>;
    expect(input.slice(1)).toEqual(items);
  });

  /*
   * A round that came from the other transport has no items, and there was
   * never anything more to it than the message - so it is rebuilt as before.
   */
  it('still rebuilds a round that has no items', () => {
    const items = toResponsesInput([{ role: 'assistant', content: 'done', tool_calls: [] }]);

    expect(items).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
    ]);
  });
});

/*
 * `response_output` is Fleet's own carrier, not a field Chat Completions
 * accepts, and an unknown key on that endpoint is a 400 rather than something
 * quietly ignored. Toggling deferral mid-conversation is exactly what would
 * carry one across.
 */
describe('what the other transport is allowed to see', () => {
  it('takes the carried items off before a Chat Completions body', () => {
    const kept = forCompletionsWire([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there', response_output: [{ type: 'reasoning' }] }
    ]);

    expect(kept[1]).toEqual({ role: 'assistant', content: 'there' });
  });

  it('leaves everything else exactly as it was', () => {
    const messages: AgentWireMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'assistant', content: 'ok', reasoning_details: [{ type: 'x' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' }
    ];

    expect(forCompletionsWire(messages)).toEqual(messages);
  });
});
