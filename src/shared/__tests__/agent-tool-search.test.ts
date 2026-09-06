import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_SEARCH_INSTRUCTIONS,
  DEFAULT_AGENT_TOOL_SEARCH,
  TOOL_SEARCH_TOOL_NAME,
  splitDeferred,
  toolSearchSpec
} from '../agent-tool-search';
import type { ToolSpec } from '../agent-tools';

const MCP: ToolSpec[] = [
  { type: 'function', function: { name: 'ctx7_docs', description: 'd', parameters: {} } },
  { type: 'function', function: { name: 'exa_search', description: 'e', parameters: {} } }
];

describe('the tool as the request states it', () => {
  it('is absent when deferral is off', () => {
    expect(toolSearchSpec({ ...DEFAULT_AGENT_TOOL_SEARCH, enabled: false })).toBeNull();
  });

  it('states the result cap rather than leaving it to a default that could drift', () => {
    expect(toolSearchSpec({ enabled: true, maxResults: 8 })).toEqual({
      type: TOOL_SEARCH_TOOL_NAME,
      parameters: { max_results: 8 }
    });
  });

  /*
   * Off is the default because deferral trades a round for tokens, and that is
   * only the right trade for somebody with servers connected.
   */
  it('is off out of the box', () => {
    expect(DEFAULT_AGENT_TOOL_SEARCH.enabled).toBe(false);
  });
});

describe('which tools are withheld', () => {
  it('withholds the server tools when deferral is on', () => {
    expect(splitDeferred(MCP, true)).toEqual({ loaded: [], deferred: MCP });
  });

  /*
   * With deferral off the caller must still get one shape back, or every call
   * site grows a branch that can be forgotten in one of them.
   */
  it('states them all when deferral is off', () => {
    expect(splitDeferred(MCP, false)).toEqual({ loaded: MCP, deferred: [] });
  });

  it('has nothing to withhold when no server is connected', () => {
    expect(splitDeferred([], true)).toEqual({ loaded: [], deferred: [] });
  });
});

describe('what the model is told', () => {
  /*
   * Without this the deferred half is invisible: the model reads the tools it
   * was given, concludes the task cannot be done, and says so.
   */
  it('tells the model the list is incomplete and names the tool that completes it', () => {
    expect(AGENT_TOOL_SEARCH_INSTRUCTIONS).toContain('not all of them');
    expect(AGENT_TOOL_SEARCH_INSTRUCTIONS).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it('says to search before concluding something cannot be done', () => {
    expect(AGENT_TOOL_SEARCH_INSTRUCTIONS).toContain('Search before you conclude');
  });

  /* A discovered tool is dispatched and permission-gated exactly like any other. */
  it('says a found tool behaves like a given one', () => {
    expect(AGENT_TOOL_SEARCH_INSTRUCTIONS).toContain('used exactly like one you were given');
  });
});
