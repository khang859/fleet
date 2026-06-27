import { z } from 'zod';
import type { WebSearchProviderId } from '../../shared/chat-types';

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebSearchArgs = {
  query: string;
  apiKey: string;
  maxResults: number;
  signal?: AbortSignal;
};

export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  search(args: WebSearchArgs): Promise<WebSearchResult[]>;
}

const SNIPPET_CAP = 500;

/** Throw a uniform error for a non-2xx provider response. */
async function ensureOk(res: Response): Promise<void> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Web search failed: ${res.status} ${detail}`.trim());
  }
}

/** Normalize one provider hit to the shared shape (title falls back to the URL). */
function toResult(title: string | undefined, url: string, snippet: string): WebSearchResult {
  return { title: title?.trim() || url, url, snippet: snippet.slice(0, SNIPPET_CAP) };
}

const TAVILY_SCHEMA = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string(),
        content: z.string().optional()
      })
    )
    .optional()
});

/** Tavily (https://tavily.com) — a simple LLM-oriented search JSON API. */
export class TavilyProvider implements WebSearchProvider {
  readonly id = 'tavily' as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(args: WebSearchArgs): Promise<WebSearchResult[]> {
    const res = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: args.apiKey,
        query: args.query,
        max_results: args.maxResults,
        search_depth: 'basic'
      }),
      signal: args.signal
    });
    await ensureOk(res);
    const parsed = TAVILY_SCHEMA.parse(await res.json());
    return (parsed.results ?? [])
      .slice(0, args.maxResults)
      .map((r) => toResult(r.title, r.url, r.content ?? ''));
  }
}

const EXA_SCHEMA = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string(),
        text: z.string().optional()
      })
    )
    .optional()
});

/** Exa (https://exa.ai) — neural search; we request short text contents per hit. */
export class ExaProvider implements WebSearchProvider {
  readonly id = 'exa' as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(args: WebSearchArgs): Promise<WebSearchResult[]> {
    const res = await this.fetchImpl('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': args.apiKey },
      body: JSON.stringify({
        query: args.query,
        numResults: args.maxResults,
        type: 'auto',
        contents: { text: { maxCharacters: SNIPPET_CAP } }
      }),
      signal: args.signal
    });
    await ensureOk(res);
    const parsed = EXA_SCHEMA.parse(await res.json());
    return (parsed.results ?? [])
      .slice(0, args.maxResults)
      .map((r) => toResult(r.title, r.url, r.text ?? ''));
  }
}

const BRAVE_SCHEMA = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string(),
            description: z.string().optional()
          })
        )
        .optional()
    })
    .optional()
});

/** Brave's `description` carries `<strong>` highlight tags around the matched terms. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** Brave Search (https://brave.com/search/api) — GET with a subscription token. */
export class BraveProvider implements WebSearchProvider {
  readonly id = 'brave' as const;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async search(args: WebSearchArgs): Promise<WebSearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(args.maxResults));
    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': args.apiKey },
      signal: args.signal
    });
    await ensureOk(res);
    const parsed = BRAVE_SCHEMA.parse(await res.json());
    return (parsed.web?.results ?? [])
      .slice(0, args.maxResults)
      .map((r) => toResult(r.title, r.url, stripHtml(r.description ?? '')));
  }
}

export function createWebSearchProvider(
  id: WebSearchProviderId,
  fetchImpl: typeof fetch = fetch
): WebSearchProvider {
  switch (id) {
    case 'exa':
      return new ExaProvider(fetchImpl);
    case 'brave':
      return new BraveProvider(fetchImpl);
    case 'tavily':
      return new TavilyProvider(fetchImpl);
    default: {
      // Compile-time exhaustiveness + a runtime guard against a corrupt/stale
      // provider id persisted in settings (would otherwise return undefined).
      const _exhaustive: never = id;
      throw new Error(`Unknown web-search provider: ${String(_exhaustive)}`);
    }
  }
}

/** Format results for the model: numbered entries with titles, URLs, snippets. */
export function formatWebSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web results for "${query}".`;
  const blocks = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
  );
  return `Web search results for "${query}":\n\n${blocks.join('\n\n')}`;
}
