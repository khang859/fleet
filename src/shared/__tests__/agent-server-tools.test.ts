import { describe, expect, it } from 'vitest';
import {
  citationsFromResult,
  isServerToolName,
  mergeCitations,
  serverToolLabel,
  serverToolQuery,
  serverToolStops,
  toReasoningDetails,
  type Citation,
  type ServerToolRecord
} from '../agent-server-tools';

/**
 * The boundary between what OpenRouter runs and what Fleet runs.
 *
 * Most of what is asserted here is about not losing things: a source the model
 * cited, a record the model needs to see again next round, a step cap that
 * would otherwise be silently traded away for a spend cap.
 */

describe('isServerToolName', () => {
  it('separates OpenRouter names from names Fleet dispatches', () => {
    expect(isServerToolName('openrouter:web_search')).toBe(true);
    expect(isServerToolName('openrouter:advisor')).toBe(true);
    expect(isServerToolName('web_fetch')).toBe(false);
    expect(isServerToolName('read')).toBe(false);
    // Not a prefix match on a name that merely contains it.
    expect(isServerToolName('mcp_openrouter:search')).toBe(false);
  });
});

describe('serverToolStops', () => {
  // The trap the whole function exists for: `stop_server_tools_when` replaces
  // `max_tool_calls` rather than narrowing it, so a request asking only for a
  // spend stop has quietly given up the 30-step default.
  it('restates the step cap whenever it states a spend cap', () => {
    expect(serverToolStops({ steps: 10, maxSpendUsd: 0.5 })).toEqual([
      { type: 'step_count_is', step_count: 10 },
      { type: 'max_cost', max_cost_in_dollars: 0.5 }
    ]);
  });

  it('sends nothing at all when there is no spend cap, keeping their default', () => {
    expect(serverToolStops({ steps: 10, maxSpendUsd: null })).toBeNull();
  });

  it('treats a zero cap as a cap rather than as an absence', () => {
    expect(serverToolStops({ steps: 4, maxSpendUsd: 0 })).toEqual([
      { type: 'step_count_is', step_count: 4 },
      { type: 'max_cost', max_cost_in_dollars: 0 }
    ]);
  });
});

describe('serverToolLabel', () => {
  it('reads the wire name as words', () => {
    expect(serverToolLabel('openrouter:web_search')).toBe('web search');
    expect(serverToolLabel('openrouter:apply_patch')).toBe('apply patch');
  });

  it('still labels a tool this build has never heard of', () => {
    expect(serverToolLabel('openrouter:some_future_thing')).toBe('some future thing');
    expect(serverToolLabel('bare_name')).toBe('bare name');
  });
});

describe('serverToolQuery', () => {
  it('finds the query under whichever key the provider used', () => {
    expect(serverToolQuery('{"query":"zod v4 migration"}')).toBe('zod v4 migration');
    expect(serverToolQuery('{"q":"electron ipc"}')).toBe('electron ipc');
    expect(serverToolQuery('{"url":"https://example.com/a"}')).toBe('https://example.com/a');
  });

  it('gives up quietly on arguments it cannot read', () => {
    expect(serverToolQuery('not json')).toBeNull();
    expect(serverToolQuery('{"depth":3}')).toBeNull();
    expect(serverToolQuery('{"query":""}')).toBeNull();
    expect(serverToolQuery('[]')).toBeNull();
  });
});

describe('citationsFromResult', () => {
  it('reads a bare array of results', () => {
    expect(citationsFromResult('[{"url":"https://a.dev","title":"A","content":"body"}]')).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'body', startIndex: null, endIndex: null }
    ]);
  });

  it('reads the wrapped shapes too', () => {
    const results = citationsFromResult('{"results":[{"url":"https://b.dev","text":"t"}]}');
    expect(results).toEqual([
      { url: 'https://b.dev', title: null, content: 't', startIndex: null, endIndex: null }
    ]);

    const cited = citationsFromResult('{"citations":[{"url":"https://c.dev","snippet":"s"}]}');
    expect(cited).toEqual([
      { url: 'https://c.dev', title: null, content: 's', startIndex: null, endIndex: null }
    ]);
  });

  it('returns nothing rather than throwing on a payload it does not know', () => {
    expect(citationsFromResult('nonsense')).toEqual([]);
    expect(citationsFromResult('{"status":"ok"}')).toEqual([]);
    // A source with no address is not a source anyone can follow.
    expect(citationsFromResult('[{"title":"no address"}]')).toEqual([]);
  });
});

describe('mergeCitations', () => {
  // The reason both routes are read: the annotation knows where in the answer
  // the page was used, the result payload knows what the model was shown, and
  // neither copy is the complete one.
  it('keeps one row per url and fills its blanks from the other copy', () => {
    const annotated: Citation[] = [
      { url: 'https://a.dev', title: 'A', content: null, startIndex: 10, endIndex: 20 }
    ];
    const fromResult: Citation[] = [
      {
        url: 'https://a.dev',
        title: 'A (long)',
        content: 'excerpt',
        startIndex: null,
        endIndex: null
      }
    ];

    expect(mergeCitations(annotated, fromResult)).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'excerpt', startIndex: 10, endIndex: 20 }
    ]);
  });

  it('keeps first-seen order across groups', () => {
    const first: Citation[] = [
      { url: 'https://a.dev', title: null, content: null, startIndex: null, endIndex: null }
    ];
    const second: Citation[] = [
      { url: 'https://b.dev', title: null, content: null, startIndex: null, endIndex: null },
      { url: 'https://a.dev', title: null, content: null, startIndex: null, endIndex: null }
    ];

    expect(mergeCitations(first, second).map((c) => c.url)).toEqual([
      'https://a.dev',
      'https://b.dev'
    ]);
  });
});

describe('toReasoningDetails', () => {
  const record: ServerToolRecord = {
    callId: 'call_1',
    toolName: 'openrouter:web_search',
    args: '{"query":"a"}',
    result: '[{"url":"https://a.dev"}]',
    citations: []
  };

  it('sends the arguments and result back exactly as they arrived', () => {
    expect(toReasoningDetails([record])).toEqual([
      {
        type: 'reasoning.server_tool_call',
        tool_name: 'openrouter:web_search',
        arguments: '{"query":"a"}',
        result: '[{"url":"https://a.dev"}]',
        tool_call_id: 'call_1'
      }
    ]);
  });

  it('omits the call id rather than sending a null one', () => {
    const [detail] = toReasoningDetails([{ ...record, callId: null }]);
    expect(detail).not.toHaveProperty('tool_call_id');
  });

  // `index` numbers a record within one response, and one assistant message
  // here may carry records gathered over several rounds. Array order says the
  // same thing without inventing or repeating a numbering.
  it('never sends an index', () => {
    const details = toReasoningDetails([record, { ...record, callId: 'call_2' }]);
    for (const detail of details) expect(detail).not.toHaveProperty('index');
  });
});
