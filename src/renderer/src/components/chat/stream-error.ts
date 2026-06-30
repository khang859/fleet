/** A classified stream failure, ready to render as a plain-language inline error. */
export type StreamErrorInfo = {
  kind: 'network' | 'auth' | 'quota' | 'server' | 'generic';
  /** Whether a retry could plausibly succeed (drives the "Try again" button). */
  retryable: boolean;
  /** Short headline. */
  title: string;
  /** One-line, plain-language guidance — never a raw status code. */
  detail: string;
};

/**
 * Keep a clean, short human message but never surface a raw upstream dump (a
 * status line or JSON body) — the `detail` contract is "never a raw status
 * code". Anything that looks like a status code, a JSON body, or an oversized
 * blob collapses to a generic line.
 */
function sanitizeDetail(raw: string): string {
  const trimmed = raw.trim();
  // A status code, a JSON body (object `{` or array `[`), or an oversized blob
  // all read as a raw dump and collapse to the generic line.
  const looksRaw = /\b[1-5]\d\d\b/.test(trimmed) || /[{[]/.test(trimmed) || trimmed.length > 160;
  return looksRaw ? 'The response could not be completed. Try again.' : trimmed;
}

/**
 * Classify a raw stream-error message into an actionable category. Distinguishes
 * transient network problems (retryable) from auth/quota problems that need the
 * user to fix configuration, so the UI can guide recovery instead of dumping a
 * raw code.
 */
export function classifyStreamError(raw: string | null): StreamErrorInfo {
  const msg = (raw ?? '').toLowerCase();

  const has = (...needles: string[]): boolean => needles.some((n) => msg.includes(n));

  if (
    has('401', '403', 'unauthor', 'invalid api key', 'invalid key', 'no api key', 'authentication')
  ) {
    return {
      kind: 'auth',
      retryable: false,
      title: 'Authentication failed',
      detail: 'Check your OpenRouter API key in Settings.'
    };
  }

  if (
    has(
      '402',
      '429',
      'quota',
      'credit',
      'insufficient',
      'billing',
      'rate limit',
      'rate-limit',
      'too many requests'
    )
  ) {
    return {
      kind: 'quota',
      retryable: true,
      title: 'Quota or rate limit reached',
      detail: 'Check your OpenRouter credits, or wait a moment and try again.'
    };
  }

  // 5xx (and the common upstream phrasings) are transient/server-side — retryable
  // and classified BEFORE generic so the raw "request failed: 500 {...}" body is
  // never echoed. \b5\d\d\b avoids matching counts like "5000 tokens".
  if (
    /\b5\d\d\b/.test(msg) ||
    has('internal server error', 'bad gateway', 'service unavailable', 'gateway timeout')
  ) {
    return {
      kind: 'server',
      retryable: true,
      title: 'Service temporarily unavailable',
      detail: 'The model provider had a problem on its end. Wait a moment and try again.'
    };
  }

  if (
    has(
      'network',
      'timeout',
      'timed out',
      'fetch',
      'econn',
      'enotfound',
      'socket',
      'offline',
      'connection'
    )
  ) {
    return {
      kind: 'network',
      retryable: true,
      title: 'Connection problem',
      detail: 'Check your network and try again.'
    };
  }

  return {
    kind: 'generic',
    retryable: true,
    title: 'Something went wrong',
    detail: raw?.trim() ? sanitizeDetail(raw) : 'The response could not be completed. Try again.'
  };
}
