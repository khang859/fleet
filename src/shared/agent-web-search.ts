import type { ServerToolSpec } from './agent-server-tools';

/**
 * Searching the web, as OpenRouter runs it.
 *
 * The one thing the agent's own tool list cannot do. `web_fetch` reads a page
 * whose address you already have; nothing here reaches "which release note says
 * this", "is there an open issue about it", "what does the current API look
 * like". A coding agent without that has to be told the URL by the person it is
 * supposed to be saving the reading for.
 *
 * It is a server tool rather than a local one because the alternative is Fleet
 * holding a search API key, choosing a ranking, and paying a second bill. The
 * model asks OpenRouter, OpenRouter searches, and what comes back is sources
 * and excerpts. Fleet's part is deciding whether it is offered, bounding it, and
 * showing where the answer came from.
 */

/**
 * Which search backend runs the query.
 *
 * `auto` is OpenRouter's default and is deliberately not Fleet's. It means
 * "native search where the model has it, Exa otherwise", so what a search costs,
 * how many results it returns, and which of the filters apply all change with
 * the model in the picker - and the user did not change anything. `exa` is one
 * documented price and one documented set of limits whatever the model is,
 * which is the right thing to start from. Someone who has measured their own
 * tasks and prefers another engine can say so.
 */
export const WEB_SEARCH_ENGINES = [
  'auto',
  'native',
  'exa',
  'parallel',
  'perplexity',
  'firecrawl'
] as const;
export type WebSearchEngine = (typeof WEB_SEARCH_ENGINES)[number];

export type AgentWebSearchConfig = {
  /** `false` ⇒ the tool is not in the request at all. */
  enabled: boolean;
  engine: WebSearchEngine;
  /** Results one search may return. */
  maxResults: number;
  /**
   * Searches one request may run.
   *
   * A request-level cap rather than a turn-level one, and that is the trap in
   * it: a turn is many requests, one per round, and this number starts again on
   * every one of them. A turn of twenty rounds can therefore run twenty times
   * this many searches. `maxSpendUsd` is what actually bounds the turn, and it
   * is why this defaults low.
   */
  maxSearches: number;
  /**
   * Dollars of remote work one request may do before OpenRouter is asked to
   * wind up. `null` ⇒ no stop condition is sent and the 30-step default stands.
   *
   * Not a ceiling. Crossing it finishes the calls already running and takes one
   * more turn to answer, so the amount billed is above this. Per request, like
   * `maxSearches`, and restarting each round for the same reason.
   */
  maxSpendUsd: number | null;
  /**
   * Characters of one page's excerpt that reach the model. `null` ⇒ the engine
   * chooses, which for Exa is an adaptive 2-4k per result.
   */
  maxCharacters: number | null;
};

export const DEFAULT_AGENT_WEB_SEARCH: AgentWebSearchConfig = {
  // Off until it is chosen. It spends money at a second meter - per search,
  // beside the tokens - and an upgrade that quietly starts billing somebody for
  // something they did not ask for is not an upgrade.
  enabled: false,
  engine: 'exa',
  maxResults: 5,
  maxSearches: 5,
  maxSpendUsd: 0.5,
  maxCharacters: null
};

/** What the settings will accept. OpenRouter's own limits, not ours. */
export const WEB_SEARCH_MIN_RESULTS = 1;
export const WEB_SEARCH_MAX_RESULTS = 25;
export const WEB_SEARCH_MIN_SEARCHES = 1;
export const WEB_SEARCH_MAX_SEARCHES = 30;
export const WEB_SEARCH_MIN_CHARACTERS = 1_000;
export const WEB_SEARCH_MAX_CHARACTERS = 100_000;

/**
 * The tool entry for one turn, or `null` when there is not one to send.
 *
 * `max_uses` and `max_results` are stated on the tool; the spend stop is not,
 * because it bounds the whole request rather than this tool and belongs beside
 * `messages` instead. See `serverToolStops`.
 *
 * `engine: 'auto'` is sent as an omission rather than as the word. It is
 * OpenRouter's own default, so leaving it out says the same thing and keeps the
 * body honest about what Fleet is actually asking for.
 */
export function webSearchSpec(config: AgentWebSearchConfig): ServerToolSpec | null {
  if (!config.enabled) return null;
  return {
    type: 'openrouter:web_search',
    parameters: {
      ...(config.engine === 'auto' ? {} : { engine: config.engine }),
      max_results: config.maxResults,
      max_uses: config.maxSearches,
      ...(config.maxCharacters === null ? {} : { max_characters: config.maxCharacters })
    }
  };
}

/**
 * What the model is told about the tool it has been given.
 *
 * Added to the system prompt only when search is on, and it says the one thing
 * the tool description on the wire cannot: that Fleet has a reader of its own,
 * and which of the two to reach for. Without this the model has a search tool
 * and a fetch tool from two different places and no account of how they relate,
 * and the failure mode is searching the web for a dev server on localhost.
 */
export const AGENT_WEB_SEARCH_INSTRUCTIONS = [
  '## Web search',
  '',
  'You can search the web. Use it when the answer depends on something current or something you do not know the address of - a library API, a release note, an open issue, an error message nobody has seen before.',
  'Search before guessing at an API you are not sure of. A wrong signature written confidently costs more than a search.',
  'Do not search for anything in this folder, on this machine, or on this network. Read those with your own tools.',
  'When you have the address of a page already, fetch it rather than searching for it.',
  'Say where an answer came from when it came from a search.'
].join('\n');
