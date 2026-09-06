import { describe, expect, it } from 'vitest';
import {
  AGENT_WEB_SEARCH_INSTRUCTIONS,
  DEFAULT_AGENT_WEB_SEARCH,
  webSearchSpec,
  type AgentWebSearchConfig
} from '../agent-web-search';

const on: AgentWebSearchConfig = { ...DEFAULT_AGENT_WEB_SEARCH, enabled: true };

describe('webSearchSpec', () => {
  it('offers nothing when search is off', () => {
    expect(webSearchSpec(DEFAULT_AGENT_WEB_SEARCH)).toBeNull();
  });

  it('states the engine and both per-request bounds', () => {
    expect(webSearchSpec({ ...on, engine: 'exa', maxResults: 5, maxSearches: 3 })).toEqual({
      type: 'openrouter:web_search',
      parameters: { engine: 'exa', max_results: 5, max_uses: 3 }
    });
  });

  // `auto` is OpenRouter's own default, so saying it and leaving it out mean
  // the same thing - and leaving it out keeps the body honest about what Fleet
  // is actually asking for.
  it('omits the engine when it is the one OpenRouter would pick anyway', () => {
    const spec = webSearchSpec({ ...on, engine: 'auto' });
    expect(spec?.parameters).not.toHaveProperty('engine');
  });

  it('only sends an excerpt limit when one was chosen', () => {
    expect(webSearchSpec({ ...on, maxCharacters: null })?.parameters).not.toHaveProperty(
      'max_characters'
    );
    expect(webSearchSpec({ ...on, maxCharacters: 4000 })?.parameters).toMatchObject({
      max_characters: 4000
    });
  });

  // The spend brake bounds the whole request rather than this one tool, so it
  // belongs beside `messages` in `stop_server_tools_when` - not here.
  it('keeps the spend brake off the tool entry', () => {
    expect(JSON.stringify(webSearchSpec({ ...on, maxSpendUsd: 0.25 }))).not.toContain('cost');
  });
});

describe('defaults', () => {
  // It bills at a second meter, per search, beside the tokens. An upgrade that
  // starts spending somebody's money unasked is not an upgrade.
  it('ships off', () => {
    expect(DEFAULT_AGENT_WEB_SEARCH.enabled).toBe(false);
  });

  it('ships with a brake on', () => {
    expect(DEFAULT_AGENT_WEB_SEARCH.maxSpendUsd).not.toBeNull();
  });
});

describe('AGENT_WEB_SEARCH_INSTRUCTIONS', () => {
  // Without this the model holds a search tool and a fetch tool from two
  // different places and no account of how they relate, and searches the web
  // for a dev server on localhost.
  it('tells the model which of the two readers to reach for', () => {
    expect(AGENT_WEB_SEARCH_INSTRUCTIONS).toContain('fetch');
    expect(AGENT_WEB_SEARCH_INSTRUCTIONS.toLowerCase()).toContain('this machine');
  });
});
