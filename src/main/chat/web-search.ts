import { z } from 'zod';

export type WebSearchProviderId = 'tavily';

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

const SNIPPET_CAP = 500;

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
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Web search failed: ${res.status} ${detail}`.trim());
    }
    const parsed = TAVILY_SCHEMA.parse(await res.json());
    return (parsed.results ?? []).slice(0, args.maxResults).map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      snippet: (r.content ?? '').slice(0, SNIPPET_CAP)
    }));
  }
}

export function createWebSearchProvider(
  id: WebSearchProviderId,
  fetchImpl: typeof fetch = fetch
): WebSearchProvider {
  // Only Tavily is implemented today; the union keeps the surface pluggable.
  return new TavilyProvider(fetchImpl);
}

/** Format results for the model: numbered entries with titles, URLs, snippets. */
export function formatWebSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) return `No web results for "${query}".`;
  const blocks = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
  );
  return `Web search results for "${query}":\n\n${blocks.join('\n\n')}`;
}
