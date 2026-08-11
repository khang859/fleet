import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capResult, extractContent, type PageRenderer } from '../fetch';

/**
 * The pipeline, against a real server.
 *
 * A stubbed `fetch` would test almost none of what is here: the redirect loop,
 * the pinned lookup, the decompression, and the byte cap all live below the
 * point a stub replaces. So each test starts an HTTP server on the loopback
 * address and lets the whole thing run for real, which is also the only way to
 * find out that `node:https` hands back a gzipped body where `fetch` did not.
 *
 * `allowLocal: true` throughout for that reason. The one thing it does not
 * relax is the metadata carve-out, and there is a test below that says so.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | null = null;

/** Start a one-off server and give back the address it is listening on. */
async function serve(handler: Handler): Promise<string> {
  const next = createServer(handler);
  server = next;
  await new Promise<void>((ready) => next.listen(0, '127.0.0.1', ready));
  const address = next.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  const running = server;
  server = null;
  if (running !== null) await new Promise<void>((closed) => running.close(() => closed()));
});

const ARTICLE = `<!doctype html><html><head><title>Widget API</title></head><body>
  <nav>home about contact</nav>
  <article>
    <h1>Widget API</h1>
    <p>${'The widget endpoint accepts a name and returns a widget. '.repeat(12)}</p>
    <pre><code>widget.create({ name: 'x' })</code></pre>
  </article>
</body></html>`;

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

const fetchIt = async (url: string): Promise<string> =>
  extractContent({ url, allowLocal: true, deps: {}, signal: new AbortController().signal });

describe('reading a page', () => {
  it('returns the article as markdown, with its title and source', async () => {
    const base = await serve((_req, res) => html(res, ARTICLE));
    const text = await fetchIt(base);

    expect(text).toContain('# Widget API');
    expect(text).toContain(`Source: ${base}`);
    expect(text).toContain('The widget endpoint accepts a name');
    // Readability's whole job: the chrome around the article goes.
    expect(text).not.toContain('home about contact');
  });

  it('marks the page as something the model reads rather than obeys', async () => {
    const base = await serve((_req, res) => html(res, ARTICLE));
    const text = await fetchIt(base);
    expect(text).toContain('not by the user and not by Fleet');
  });

  it('hands back plain text untouched', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('CHANGELOG\n\n1.2.0 - fixed the thing');
    });

    expect(await fetchIt(base)).toContain('1.2.0 - fixed the thing');
  });

  it('undoes the compression it asked for', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from(ARTICLE)));
    });

    expect(await fetchIt(base)).toContain('The widget endpoint accepts a name');
  });

  it('refuses a type it cannot read, and says which', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    });

    const text = await fetchIt(base);
    expect(text).toContain('application/pdf');
    expect(text).toContain('only reads web pages and text');
  });

  it('reports a failed status rather than pretending the page was empty', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>nope</body></html>');
    });

    await expect(fetchIt(base)).rejects.toThrow(/404/);
  });

  it('says so plainly when the page needs JavaScript and none can be run', async () => {
    const base = await serve((_req, res) => {
      html(res, '<!doctype html><html><body><div id="root"></div></body></html>');
    });

    // No `render` in deps, which is the "no browser available" case.
    expect(await fetchIt(base)).toContain('needs JavaScript');
  });
});

/*
 * The case the whole render path exists for, and the one it quietly did not
 * cover: a dev server on this machine is `http://localhost:PORT`, it serves an
 * empty root div, and gating the render on `https:` meant every one of them
 * came back as "needs JavaScript" with a browser sitting right there.
 */
describe('a page that builds itself', () => {
  const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';

  it('is rendered even when it is a dev server on this machine', async () => {
    const base = await serve((_req, res) => html(res, SHELL));
    const render = vi.fn<PageRenderer>(async () => Promise.resolve(ARTICLE));

    const text = await extractContent({
      url: base,
      allowLocal: true,
      deps: { render },
      signal: new AbortController().signal
    });

    expect(text).toContain('# Widget API');
    expect(render).toHaveBeenCalledOnce();
  });

  it('lets a local page reach local addresses for its own bundle', async () => {
    const base = await serve((_req, res) => html(res, SHELL));
    const render = vi.fn<PageRenderer>(async () => Promise.resolve(ARTICLE));

    await extractContent({
      url: base,
      allowLocal: true,
      deps: { render },
      signal: new AbortController().signal
    });

    expect(render.mock.calls[0][1]).toBe(true);
  });
});

describe('redirects', () => {
  it('follows them and reports the address it ended on', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/middle' });
        res.end();
        return;
      }
      if (req.url === '/middle') {
        res.writeHead(301, { location: '/end' });
        res.end();
        return;
      }
      html(res, ARTICLE);
    });

    const text = await fetchIt(`${base}/start`);
    expect(text).toContain('# Widget API');
    expect(text).toContain(`Source: ${base}/end`);
  });

  it('gives up rather than following a loop forever', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    });

    await expect(fetchIt(`${base}/again`)).rejects.toThrow(/Too many redirects/);
  });

  /*
   * The load-bearing one. A page that is allowed to be read is not thereby
   * allowed to send us anywhere, so every hop is judged again from scratch -
   * otherwise a public page redirecting to the metadata endpoint reaches it on
   * the strength of the first URL's verdict.
   */
  it('re-judges every hop, so a redirect cannot reach metadata', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    await expect(fetchIt(`${base}/bounce`)).rejects.toThrow(/metadata/);
  });

  it('says what actually went wrong when a redirect names nowhere to go', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302);
      res.end();
    });

    await expect(fetchIt(base)).rejects.toThrow(/nowhere to go/);
  });
});

describe('what the local setting governs', () => {
  it('refuses the loopback address when local addresses are off', async () => {
    const base = await serve((_req, res) => html(res, ARTICLE));

    await expect(
      extractContent({
        url: base,
        allowLocal: false,
        deps: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/turned off/);
  });

  it('never lets the setting reach metadata, even switched on', async () => {
    await expect(
      extractContent({
        url: 'http://169.254.169.254/latest/meta-data/',
        allowLocal: true,
        deps: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/metadata/);
  });

  it('refuses a name that resolves onto this machine when local is off', async () => {
    await expect(
      extractContent({
        url: 'http://localhost/',
        allowLocal: false,
        deps: {},
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/turned off/);
  });
});

describe('capResult', () => {
  it('leaves a short page alone', () => {
    expect(capResult('short', 100)).toBe('short');
  });

  it('cuts a long one and says it did', () => {
    const capped = capResult('x'.repeat(500), 100);
    expect(capped).toContain('truncated to 100 characters');
    expect(capped.startsWith('x'.repeat(100))).toBe(true);
  });

  /*
   * A hand-edited settings file can put anything in `maxChars`, and `NaN` is
   * the one that fails silently: every comparison against it is false, so the
   * page would come back as nothing at all rather than as an error.
   */
  it('falls back to the default rather than returning nothing', () => {
    expect(capResult('a page', Number.NaN)).toBe('a page');
    expect(capResult('a page', 0)).toBe('a page');
  });

  it('never cuts a character in half', () => {
    // Every emoji here is a surrogate pair, so a cut at an odd index lands
    // between the two halves of one - and a lone surrogate is not text.
    const capped = capResult('😀'.repeat(50), 11);
    expect(capped.startsWith('😀'.repeat(5))).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(capped.split('\n')[0])).toBe(false);
  });
});
