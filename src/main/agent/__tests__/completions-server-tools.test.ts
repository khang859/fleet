import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamCompletion, type CompletionsTarget } from '../completions';
import { openRouterTarget } from '../openrouter';
import type { AgentUsage } from '../../../shared/agent-types';

/**
 * Work OpenRouter did, on its way through the parser.
 *
 * On Chat Completions a server tool does not arrive as a `tool_call`. It
 * arrives as a `reasoning.server_tool_call` record on the delta, already
 * finished, and the only things that can go wrong are losing it, trying to run
 * it, or double-counting what it cost. One case for each.
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

/** Answers with an SSE stream of the given chunks, capturing what was asked. */
function streaming(chunks: unknown[]): Sent[] {
  const sent: Sent[] = [];
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), 'data: [DONE]'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push({ body: JSON.parse(init.body) as Sent['body'] });
      return Promise.resolve(new Response(`${lines.join('\n\n')}\n\n`, { status: 200 }));
    })
  );
  return sent;
}

const base = {
  model: 'openai/gpt-5.6-luna',
  messages: [],
  maxTokens: null,
  temperature: null,
  reasoning: null,
  signal: new AbortController().signal,
  onDelta: () => {},
  onReasoning: () => {}
};

const SEARCH = { type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 5 } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what reaches the request body', () => {
  it('sends server tools and local tools in the one array', async () => {
    const sent = streaming([{ choices: [{ delta: {} }] }]);
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: {} } }],
      serverTools: [SEARCH]
    });
    expect(sent[0].body.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'r', parameters: {} } },
      SEARCH
    ]);
  });

  /*
   * The gate that matters. A local llama-server has no executor for these, and
   * sending one is a 400 on a request the user did not know differed - so the
   * target decides, not the caller.
   */
  it('drops them entirely for an endpoint that cannot run them', async () => {
    const sent = streaming([{ choices: [{ delta: {} }] }]);
    await streamCompletion({ ...base, target: LOCAL, serverTools: [SEARCH] });
    expect(sent[0].body).not.toHaveProperty('tools');
    expect(sent[0].body).not.toHaveProperty('stop_server_tools_when');
  });

  it('sends stop conditions only alongside the tools they bound', async () => {
    const stops = [
      { type: 'step_count_is' as const, step_count: 10 },
      { type: 'max_cost' as const, max_cost_in_dollars: 0.5 }
    ];

    const withTools = streaming([{ choices: [{ delta: {} }] }]);
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      serverTools: [SEARCH],
      serverToolStops: stops
    });
    expect(withTools[0].body.stop_server_tools_when).toEqual(stops);

    vi.unstubAllGlobals();

    const withoutTools = streaming([{ choices: [{ delta: {} }] }]);
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      serverTools: [],
      serverToolStops: stops
    });
    expect(withoutTools[0].body).not.toHaveProperty('stop_server_tools_when');
  });
});

describe('reading the records back', () => {
  it('joins the fragments of one call and keeps its strings verbatim', async () => {
    streaming([
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  type: 'reasoning.server_tool_call',
                  index: 0,
                  id: 'srv_1',
                  tool_call_id: 'call_1',
                  tool_name: 'openrouter:web_search',
                  arguments: '{"query":"zod',
                  result: '[{"url":"https://a.dev",'
                }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  type: 'reasoning.server_tool_call',
                  index: 0,
                  arguments: ' v4"}',
                  result: '"title":"A"}]'
                }
              ]
            }
          }
        ]
      }
    ]);

    const out = await streamCompletion({ ...base, target: openRouterTarget('sk-or-test') });

    expect(out.serverToolCalls).toHaveLength(1);
    expect(out.serverToolCalls[0]).toMatchObject({
      callId: 'call_1',
      toolName: 'openrouter:web_search',
      args: '{"query":"zod v4"}',
      result: '[{"url":"https://a.dev","title":"A"}]'
    });
    // Never offered to local dispatch: they are not tool calls.
    expect(out.toolCalls).toEqual([]);
  });

  it('lists the sources a search found, from the result payload', async () => {
    streaming([
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                {
                  type: 'reasoning.server_tool_call',
                  index: 0,
                  tool_name: 'openrouter:web_search',
                  arguments: '{"query":"a"}',
                  result: '[{"url":"https://a.dev","title":"A","content":"body"}]'
                }
              ]
            }
          }
        ]
      }
    ]);

    const out = await streamCompletion({ ...base, target: openRouterTarget('sk-or-test') });
    expect(out.citations).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'body', startIndex: null, endIndex: null }
    ]);
  });

  /*
   * Both routes are read because neither is reliably present: the annotation
   * knows where in the answer a page was used, the result knows the excerpt.
   * A page reached by both must still be one row.
   */
  it('merges an annotated source with the same source from the result', async () => {
    streaming([
      {
        choices: [
          {
            delta: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    url: 'https://a.dev',
                    title: 'A',
                    start_index: 4,
                    end_index: 9
                  }
                }
              ],
              reasoning_details: [
                {
                  type: 'reasoning.server_tool_call',
                  index: 0,
                  tool_name: 'openrouter:web_search',
                  arguments: '{"query":"a"}',
                  result: '[{"url":"https://a.dev","content":"excerpt"}]'
                }
              ]
            }
          }
        ]
      }
    ]);

    const out = await streamCompletion({ ...base, target: openRouterTarget('sk-or-test') });
    expect(out.citations).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'excerpt', startIndex: 4, endIndex: 9 }
    ]);
  });

  // A beta API adds record kinds faster than any parser follows. One it has
  // never seen must not cost it the line it arrived on.
  it('ignores a reasoning record of a kind it does not know', async () => {
    streaming([
      {
        choices: [
          {
            delta: {
              content: 'hello',
              reasoning_details: [
                { type: 'reasoning.text', text: 'thinking' },
                { type: 'reasoning.something_new', whatever: true }
              ]
            }
          }
        ]
      }
    ]);

    let text = '';
    const out = await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onDelta: (t) => {
        text += t;
      }
    });
    expect(text).toBe('hello');
    expect(out.serverToolCalls).toEqual([]);
  });
});

describe('what it cost', () => {
  /*
   * The documentation drifts here: the feature guide says `server_tool_use`,
   * the API reference says `server_tool_use_details`. Both are read, and the
   * two counts are never added - the reference states a search is counted in
   * `tool_calls_requested` *and* in `web_search_requests`.
   */
  it('counts the calls and the searches separately, from either spelling', async () => {
    streaming([
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          cost: 0.02,
          cost_details: { server_tool_cost: 0.007 },
          server_tool_use_details: {
            tool_calls_requested: 2,
            tool_calls_executed: 2,
            web_search_requests: 2
          }
        }
      }
    ]);

    let usage: AgentUsage | null = null;
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onUsage: (u) => {
        usage = u;
      }
    });

    expect(usage).toMatchObject({
      serverToolCalls: 2,
      webSearches: 2,
      serverToolCostUsd: 0.007,
      // A breakdown of the total, never added to it.
      costUsd: 0.02
    });
  });

  it('reads the older guide spelling too', async () => {
    streaming([
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          server_tool_use: { tool_calls_requested: 3, web_search_requests: 1 }
        }
      }
    ]);

    let usage: AgentUsage | null = null;
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onUsage: (u) => {
        usage = u;
      }
    });

    expect(usage).toMatchObject({ serverToolCalls: 3, webSearches: 1 });
  });

  it('reads a stream that mentions none of this as zero rather than as missing', async () => {
    streaming([
      {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 }
      }
    ]);

    let usage: AgentUsage | null = null;
    await streamCompletion({
      ...base,
      target: openRouterTarget('sk-or-test'),
      onUsage: (u) => {
        usage = u;
      }
    });

    expect(usage).toMatchObject({
      serverToolCalls: 0,
      webSearches: 0,
      serverToolCostUsd: null
    });
  });
});
