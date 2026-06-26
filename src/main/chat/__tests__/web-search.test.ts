import { describe, it, expect, vi } from 'vitest';
import { TavilyProvider, createWebSearchProvider, formatWebSearchResults } from '../web-search';

describe('TavilyProvider', () => {
  it('maps the Tavily response to {title,url,snippet} and caps results', async () => {
    const json = {
      results: [
        { title: 'Docs', url: 'https://a.example', content: 'first' },
        { title: 'Blog', url: 'https://b.example', content: 'second' },
        { url: 'https://c.example', content: 'third' }
      ]
    };
    const fakeFetch = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify(json), { status: 200 }))
    ) as unknown as typeof fetch;
    const provider = new TavilyProvider(fakeFetch);
    const results = await provider.search({ query: 'q', apiKey: 'k', maxResults: 2 });
    expect(results).toEqual([
      { title: 'Docs', url: 'https://a.example', snippet: 'first' },
      { title: 'Blog', url: 'https://b.example', snippet: 'second' }
    ]);
    // POSTs the query + key to Tavily.
    const body = JSON.parse((fakeFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ api_key: 'k', query: 'q', max_results: 2 });
  });

  it('falls back to the URL as the title when none is provided', async () => {
    const json = { results: [{ url: 'https://x.example', content: '' }] };
    const fakeFetch = (async () =>
      Promise.resolve(
        new Response(JSON.stringify(json), { status: 200 })
      )) as unknown as typeof fetch;
    const provider = new TavilyProvider(fakeFetch);
    const results = await provider.search({ query: 'q', apiKey: 'k', maxResults: 5 });
    expect(results[0].title).toBe('https://x.example');
  });

  it('throws on a non-200 response', async () => {
    const fakeFetch = (async () =>
      Promise.resolve(new Response('nope', { status: 401 }))) as unknown as typeof fetch;
    const provider = new TavilyProvider(fakeFetch);
    await expect(provider.search({ query: 'q', apiKey: 'bad', maxResults: 5 })).rejects.toThrow(
      /Web search failed/
    );
  });
});

describe('createWebSearchProvider', () => {
  it('returns a Tavily provider', () => {
    expect(createWebSearchProvider('tavily').id).toBe('tavily');
  });
});

describe('formatWebSearchResults', () => {
  it('numbers results with titles, URLs, and snippets', () => {
    const out = formatWebSearchResults('rust async', [
      { title: 'Tokio', url: 'https://tokio.rs', snippet: 'runtime' }
    ]);
    expect(out).toContain('1. Tokio');
    expect(out).toContain('https://tokio.rs');
    expect(out).toContain('runtime');
  });

  it('reports when there are no results', () => {
    expect(formatWebSearchResults('q', [])).toContain('No web results');
  });
});
