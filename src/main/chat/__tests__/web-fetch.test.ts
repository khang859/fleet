import { describe, it, expect, vi } from 'vitest';
import { extractContent, capResult, isFetchableUrl } from '../web-fetch';

/** A `fetch` stub returning one canned body + content-type with a 200 status. */
function stubFetch(body: string, contentType: string): typeof fetch {
  return (async () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': contentType } })
    )) as unknown as typeof fetch;
}

const signal = new AbortController().signal;

const ARTICLE_HTML = `<!doctype html><html><head><title>Promises Explained</title></head>
<body>
  <header><nav>Home | About</nav></header>
  <article>
    <h1>Promises Explained</h1>
    <p>A Promise represents the eventual completion or failure of an asynchronous operation
    and its resulting value. Unlike callbacks, promises can be chained, which makes async
    code far more readable and maintainable across large and complex codebases everywhere.</p>
    <p>Promises have three states: pending, fulfilled, and rejected. Once a promise settles
    into fulfilled or rejected it stays that way permanently, which makes them reliable
    primitives for coordinating asynchronous work in real-world applications at scale.</p>
  </article>
  <footer>© 2025</footer>
</body></html>`;

// A JS-shell page: no real content server-side, content lives in the script.
const SHELL_HTML = `<!doctype html><html><head><title>App</title></head>
<body><div id="root"></div><script>renderApp()</script></body></html>`;

describe('isFetchableUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(isFetchableUrl('https://example.com/page')).toBe(true);
    expect(isFetchableUrl('http://example.com')).toBe(true);
  });

  it('rejects unsafe schemes and IPv4 SSRF targets', () => {
    expect(isFetchableUrl('file:///etc/passwd')).toBe(false);
    expect(isFetchableUrl('mailto:a@b.com')).toBe(false);
    expect(isFetchableUrl('http://localhost:3000')).toBe(false);
    expect(isFetchableUrl('http://127.0.0.1')).toBe(false);
    expect(isFetchableUrl('http://10.0.0.5')).toBe(false);
    expect(isFetchableUrl('http://192.168.1.1')).toBe(false);
    expect(isFetchableUrl('http://172.16.0.1')).toBe(false);
    expect(isFetchableUrl('http://169.254.169.254')).toBe(false);
    expect(isFetchableUrl('http://0')).toBe(false); // normalizes to 0.0.0.0
    expect(isFetchableUrl('not a url')).toBe(false);
  });

  it('rejects IPv6 loopback / link-local / unique-local / mapped targets', () => {
    expect(isFetchableUrl('http://[::1]/')).toBe(false);
    expect(isFetchableUrl('http://[::]/')).toBe(false);
    expect(isFetchableUrl('http://[fe80::1]/')).toBe(false);
    expect(isFetchableUrl('http://[fc00::1]/')).toBe(false);
    expect(isFetchableUrl('http://[fd12:3456::1]/')).toBe(false);
    // IPv4-mapped 169.254.169.254 (cloud metadata) in both hex and dotted forms.
    expect(isFetchableUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data')).toBe(false);
    expect(isFetchableUrl('http://[::ffff:169.254.169.254]/')).toBe(false);
  });

  it('still accepts public IPv6 hosts', () => {
    expect(isFetchableUrl('http://[2606:4700:4700::1111]/')).toBe(true); // Cloudflare DNS
  });
});

describe('extractContent', () => {
  it('converts an HTML article to markdown with a title + source header', async () => {
    const out = await extractContent({
      url: 'https://example.com/promises',
      deps: { fetchImpl: stubFetch(ARTICLE_HTML, 'text/html; charset=utf-8') },
      signal
    });
    expect(out).toContain('# Promises Explained');
    expect(out).toContain('Source: https://example.com/promises');
    expect(out).toContain('A Promise represents the eventual completion');
    // Chrome/nav/footer stripped by readability.
    expect(out).not.toContain('Home | About');
  });

  it('returns non-HTML text verbatim without extraction', async () => {
    const json = '{"hello":"world"}';
    const out = await extractContent({
      url: 'https://api.example/data.json',
      deps: { fetchImpl: stubFetch(json, 'application/json') },
      signal
    });
    expect(out).toContain(json);
  });

  it('refuses unsupported binary content types', async () => {
    const out = await extractContent({
      url: 'https://example.com/file.pdf',
      deps: { fetchImpl: stubFetch('%PDF-1.4 ...', 'application/pdf') },
      signal
    });
    expect(out).toMatch(/unsupported content type/i);
  });

  it('falls back to the renderer for a JS-shell page', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const render = vi.fn(async () => ARTICLE_HTML);
    const out = await extractContent({
      url: 'https://spa.example',
      deps: { fetchImpl: stubFetch(SHELL_HTML, 'text/html'), render },
      signal
    });
    expect(render).toHaveBeenCalledWith('https://spa.example', signal);
    expect(out).toContain('# Promises Explained');
    expect(out).toContain('A Promise represents the eventual completion');
  });

  it('reports no readable content when a shell has no renderer', async () => {
    const out = await extractContent({
      url: 'https://spa.example',
      deps: { fetchImpl: stubFetch(SHELL_HTML, 'text/html') },
      signal
    });
    expect(out).toMatch(/no readable content/i);
  });

  it('throws on a non-2xx response', async () => {
    const failing = (async () =>
      Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch;
    await expect(
      extractContent({ url: 'https://example.com', deps: { fetchImpl: failing }, signal })
    ).rejects.toThrow(/Fetch failed/);
  });

  it('refuses an SSRF target before any request is made', async () => {
    const spy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchImpl = (async (u: string) => {
      spy(u);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      extractContent({
        url: 'http://169.254.169.254/latest/meta-data/',
        deps: { fetchImpl },
        signal
      })
    ).rejects.toThrow(/Refused to fetch/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-validates redirect targets and blocks a bounce to an internal IP', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchImpl = (async (u: string) =>
      u === 'https://safe.example/start'
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' }
          })
        : new Response('secret', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })) as unknown as typeof fetch;
    await expect(
      extractContent({ url: 'https://safe.example/start', deps: { fetchImpl }, signal })
    ).rejects.toThrow(/Refused to fetch/);
  });

  it('follows a redirect to another public URL', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const fetchImpl = (async (u: string) =>
      u === 'https://a.example/old'
        ? new Response(null, { status: 301, headers: { location: 'https://a.example/new' } })
        : new Response(ARTICLE_HTML, {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })) as unknown as typeof fetch;
    const out = await extractContent({
      url: 'https://a.example/old',
      deps: { fetchImpl },
      signal
    });
    expect(out).toContain('# Promises Explained');
  });
});

describe('capResult', () => {
  it('passes through content under the cap', () => {
    expect(capResult('short', 100)).toBe('short');
  });

  it('truncates with a marker over the cap', () => {
    const out = capResult('a'.repeat(50), 10);
    expect(out.startsWith('aaaaaaaaaa')).toBe(true);
    expect(out).toMatch(/truncated to 10 characters/);
  });

  it('does not split a surrogate pair at the cut boundary', () => {
    // '🌈' is a surrogate pair; the cut at maxChars lands between its halves.
    const content = 'a'.repeat(9) + '🌈';
    const out = capResult(content, 10);
    const body = out.split('\n\n…')[0];
    // The high surrogate is dropped rather than emitted alone.
    expect(body).toBe('a'.repeat(9));
    expect(/[\uD800-\uDBFF]/.test(body)).toBe(false);
  });
});
