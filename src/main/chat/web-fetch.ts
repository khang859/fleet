import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { isSafeExternalUrl } from '../safe-external';

/** Hard ceiling on a single fetch before it is aborted. */
const FETCH_TIMEOUT_MS = 30_000;
/** Max bytes read off the wire before we stop and treat the body as truncated. */
const MAX_BYTES = 5_000_000;
/**
 * Below this much extracted text the server HTML is treated as a JS shell, so
 * we fall back to rendering the page in a real browser. Also the readability
 * char threshold, so short-but-real pages still extract instead of rendering.
 */
const MIN_READABLE_CHARS = 200;
/** Cap on redirect hops followed (each re-validated against isFetchableUrl). */
const MAX_REDIRECTS = 5;

/** Renders a URL in a real (headless) browser and returns the post-JS outerHTML. */
export type PageRenderer = (url: string, signal: AbortSignal) => Promise<string>;

export type WebFetchDeps = {
  fetchImpl?: typeof fetch;
  /** When omitted, JS-shell pages can't be re-rendered (server HTML is used as-is). */
  render?: PageRenderer;
};

/**
 * SSRF / scheme guard: only http(s), and never a loopback or private-range host.
 * Blocks file://, localhost, 127.x, 10.x, 192.168.x, 169.254.x (link-local), etc.
 */
export function isFetchableUrl(raw: string): boolean {
  if (!isSafeExternalUrl(raw)) return false;
  let host: string;
  let protocol: string;
  try {
    const u = new URL(raw);
    host = u.hostname.toLowerCase();
    protocol = u.protocol;
  } catch {
    return false;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return false;
  if (host === '::1' || host === '[::1]') return false;
  // IPv4 private / loopback / link-local ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
/** Non-HTML text types we hand back to the model verbatim (no extraction). */
const TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/yaml',
  'text/yaml'
];

function matchesType(contentType: string, types: string[]): boolean {
  const base = contentType.split(';', 1)[0].trim().toLowerCase();
  return types.includes(base);
}

type FetchedPage = { contentType: string; body: string };

/** Read a response body with a hard byte cap so a giant file can't exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Thrown when a URL (or a redirect target) is not a public http(s) address. */
class BlockedUrlError extends Error {
  constructor(url: string) {
    super(`Refused to fetch ${url}: only public http(s) URLs are allowed.`);
    this.name = 'BlockedUrlError';
  }
}

/**
 * GET the URL with a timeout, a browser-like UA, and a byte cap. Redirects are
 * followed manually so every hop's host is re-checked against `isFetchableUrl`
 * — `redirect: 'follow'` would let a public page bounce us to an internal IP
 * (e.g. the cloud metadata endpoint) without re-validation.
 */
async function fetchPage(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<FetchedPage> {
  // One deadline across all redirect hops, not per request.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(current)) throw new BlockedUrlError(current);
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal: deadline,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break; // 3xx without a target — treat as the final response.
      current = new URL(location, current).toString(); // resolve relative redirects
      continue;
    }
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`.trim());
    }
    const contentType = res.headers.get('content-type') ?? '';
    const body = await readCapped(res);
    return { contentType, body };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
});

/** Collapse runs of 3+ blank lines and drop inline base64 data-URI image noise. */
function scrubMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Extracted = { title: string; markdown: string; textLength: number };

/**
 * Run readability over an HTML string, then convert the cleaned article HTML to
 * markdown. Returns null when readability can't find an article (e.g. a JS shell
 * or a page below the char threshold).
 */
function htmlToMarkdown(html: string): Extracted | null {
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: MIN_READABLE_CHARS }).parse();
  if (!article?.content) return null;
  const markdown = scrubMarkdown(turndown.turndown(article.content));
  if (!markdown) return null;
  return {
    title: article.title?.trim() || '',
    markdown,
    textLength: article.textContent?.trim().length ?? markdown.length
  };
}

function withHeader(url: string, title: string, body: string): string {
  const heading = title ? `# ${title}\n\n` : '';
  return `${heading}Source: ${url}\n\n${body}`;
}

/**
 * Fetch a URL and return model-readable content. HTML is sanitized to markdown
 * via readability; a JS-shell page is re-rendered (if a renderer is available)
 * and re-extracted. Non-HTML text is returned verbatim; binary types are refused.
 */
export async function extractContent(args: {
  url: string;
  deps: WebFetchDeps;
  signal: AbortSignal;
}): Promise<string> {
  const { url, deps, signal } = args;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { contentType, body } = await fetchPage(url, fetchImpl, signal);

  if (matchesType(contentType, TEXT_TYPES)) {
    return withHeader(url, '', body.trim());
  }
  if (!matchesType(contentType, HTML_TYPES)) {
    const base = contentType.split(';', 1)[0].trim() || 'unknown';
    return `Cannot read ${url}: unsupported content type "${base}". web_fetch only reads web pages and text.`;
  }

  // Fast path: the server already sent enough readable content.
  const direct = htmlToMarkdown(body);
  if (direct && direct.textLength >= MIN_READABLE_CHARS) {
    return withHeader(url, direct.title, direct.markdown);
  }

  // JS shell (or thin page): render with a real browser, then re-extract.
  if (deps.render) {
    const rendered = await deps.render(url, signal);
    const fromRender = htmlToMarkdown(rendered);
    if (fromRender?.markdown) {
      return withHeader(url, fromRender.title, fromRender.markdown);
    }
    // Last resort: strip the rendered DOM to plain text.
    const text = parseHTML(rendered).document.body.textContent.trim();
    if (text) return withHeader(url, '', scrubMarkdown(text));
  }

  // No renderer or nothing extractable — return whatever direct extraction found.
  if (direct?.markdown) return withHeader(url, direct.title, direct.markdown);
  return `Fetched ${url} but found no readable content (the page may require JavaScript).`;
}

/** Truncate the result to `maxChars`, appending a marker when content is cut. */
export function capResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // Back off one code unit if the cut lands between a surrogate pair, so we
  // never emit a lone surrogate (slice works on UTF-16 units, not code points).
  let end = maxChars;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${content.slice(0, end)}\n\n…[truncated to ${maxChars} characters]`;
}
