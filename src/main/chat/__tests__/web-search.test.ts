import { describe, it, expect, vi } from 'vitest';
import {
  TavilyProvider,
  ExaProvider,
  BraveProvider,
  createWebSearchProvider,
  formatWebSearchResults
} from '../web-search';

/** A `fetch` stub that returns one canned JSON body with a 200 status. */
function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200 })
    )) as unknown as typeof fetch;
}

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

describe('ExaProvider', () => {
  it('maps results[].{title,url,text} to the shared shape and caps results', async () => {
    const json = {
      results: [
        { title: 'Exa One', url: 'https://a.example', text: 'alpha' },
        { title: 'Exa Two', url: 'https://b.example', text: 'beta' },
        { url: 'https://c.example', text: 'gamma' }
      ]
    };
    const fakeFetch = vi.fn(jsonFetch(json));
    const provider = new ExaProvider(fakeFetch as unknown as typeof fetch);
    const results = await provider.search({ query: 'q', apiKey: 'k', maxResults: 2 });
    expect(results).toEqual([
      { title: 'Exa One', url: 'https://a.example', snippet: 'alpha' },
      { title: 'Exa Two', url: 'https://b.example', snippet: 'beta' }
    ]);
    // Sends the key in the x-api-key header and the query in the body.
    const [, init] = fakeFetch.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'k' });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      query: 'q',
      numResults: 2,
      type: 'auto'
    });
  });

  it('throws on a non-200 response', async () => {
    const fakeFetch = (async () =>
      Promise.resolve(new Response('nope', { status: 402 }))) as unknown as typeof fetch;
    const provider = new ExaProvider(fakeFetch);
    await expect(provider.search({ query: 'q', apiKey: 'bad', maxResults: 5 })).rejects.toThrow(
      /Web search failed/
    );
  });
});

describe('BraveProvider', () => {
  it('maps web.results[].{title,url,description} and strips highlight tags', async () => {
    const json = {
      web: {
        results: [
          {
            title: 'Brave One',
            url: 'https://a.example',
            description: '<strong>fast</strong> search'
          },
          { url: 'https://b.example', description: 'second' }
        ]
      }
    };
    const fakeFetch = vi.fn(jsonFetch(json));
    const provider = new BraveProvider(fakeFetch as unknown as typeof fetch);
    const results = await provider.search({ query: 'rust async', apiKey: 'tok', maxResults: 5 });
    expect(results).toEqual([
      { title: 'Brave One', url: 'https://a.example', snippet: 'fast search' },
      { title: 'https://b.example', url: 'https://b.example', snippet: 'second' }
    ]);
    // GETs with the query + count in the URL and the token in the header.
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url as string).toContain('q=rust+async');
    expect(url as string).toContain('count=5');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'tok' });
  });

  it('throws on a non-200 response', async () => {
    const fakeFetch = (async () =>
      Promise.resolve(new Response('nope', { status: 422 }))) as unknown as typeof fetch;
    const provider = new BraveProvider(fakeFetch);
    await expect(provider.search({ query: 'q', apiKey: 'bad', maxResults: 5 })).rejects.toThrow(
      /Web search failed/
    );
  });
});

describe('createWebSearchProvider', () => {
  it('returns the provider matching the id', () => {
    expect(createWebSearchProvider('tavily').id).toBe('tavily');
    expect(createWebSearchProvider('exa').id).toBe('exa');
    expect(createWebSearchProvider('brave').id).toBe('brave');
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
