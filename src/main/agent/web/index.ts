import { extractContent } from './fetch';
import { renderPage } from './render';

export { capResult } from './fetch';

/**
 * The whole of reading a page, assembled.
 *
 * The pipeline and the browser it falls back to are separate modules and are
 * joined here, so the pipeline can be tested without Electron loaded - which is
 * most of what makes the SSRF checks testable at all.
 */
export async function fetchUrl(
  url: string,
  allowLocal: boolean,
  signal: AbortSignal
): Promise<string> {
  // `renderPage` takes its own `allowLocal`, decided per page by the pipeline
  // rather than read from the setting - see `PageRenderer`.
  return extractContent({ url, allowLocal, deps: { render: renderPage }, signal });
}

export type UrlFetch = typeof fetchUrl;
