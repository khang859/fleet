/**
 * Sanitize a URL from untrusted model markdown before it reaches the DOM.
 *
 * Model output is untrusted UGC. We allow only safe, absolute protocols and
 * drop everything else (javascript:, vbscript:, file:, data:, relative/anchor
 * URLs) by returning an empty string, which Streamdown renders inert.
 *
 * @param key `'src'` for images, `'href'` for links — images are http/https only
 *   (no data: URIs), links additionally permit mailto:.
 */
export function sanitizeMarkdownUrl(url: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url); // no base → relative/anchor URLs throw and are dropped
  } catch {
    return '';
  }
  const proto = parsed.protocol;
  if (key === 'src') {
    return proto === 'http:' || proto === 'https:' ? url : '';
  }
  return proto === 'http:' || proto === 'https:' || proto === 'mailto:' ? url : '';
}
