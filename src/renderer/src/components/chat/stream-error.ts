/** A classified stream failure, ready to render as a plain-language inline error. */
export type StreamErrorInfo = {
  kind: 'network' | 'auth' | 'quota' | 'generic';
  /** Whether a retry could plausibly succeed (drives the "Try again" button). */
  retryable: boolean;
  /** Short headline. */
  title: string;
  /** One-line, plain-language guidance — never a raw status code. */
  detail: string;
};

/**
 * Classify a raw stream-error message into an actionable category. Distinguishes
 * transient network problems (retryable) from auth/quota problems that need the
 * user to fix configuration, so the UI can guide recovery instead of dumping a
 * raw code.
 */
export function classifyStreamError(raw: string | null): StreamErrorInfo {
  const msg = (raw ?? '').toLowerCase();

  const has = (...needles: string[]): boolean => needles.some((n) => msg.includes(n));

  if (has('401', '403', 'unauthor', 'invalid api key', 'invalid key', 'no api key', 'authentication')) {
    return {
      kind: 'auth',
      retryable: false,
      title: 'Authentication failed',
      detail: 'Check your OpenRouter API key in Settings.'
    };
  }

  if (has('402', '429', 'quota', 'credit', 'insufficient', 'billing', 'rate limit', 'rate-limit', 'too many requests')) {
    return {
      kind: 'quota',
      retryable: true,
      title: 'Quota or rate limit reached',
      detail: 'Check your OpenRouter credits, or wait a moment and try again.'
    };
  }

  if (has('network', 'timeout', 'timed out', 'fetch', 'econn', 'enotfound', 'socket', 'offline', 'connection')) {
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
    detail: raw?.trim() ? raw.trim() : 'The response could not be completed. Try again.'
  };
}
