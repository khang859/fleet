import type { CompletionsTarget } from './completions';

/**
 * OpenRouter, as one address among several.
 *
 * The client that does the talking is `completions.ts` and knows nothing about
 * any particular provider. What is left here is the handful of facts that are
 * true of OpenRouter alone: where it is, what it wants to be told about the
 * app, and the fact that it volunteers usage without being asked.
 *
 * The images and transcription endpoints still live entirely on OpenRouter and
 * import `APP_HEADERS` from here, which is the other reason this file stays.
 */

/** The api prefix, not the completions path: the client appends the rest. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Who is asking, on every OpenRouter request Fleet makes. */
export const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/khang859/fleet',
  'X-Title': 'Fleet'
};

/** Where a cloud model call goes, given the key the user has stored. */
export function openRouterTarget(apiKey: string): CompletionsTarget {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey,
    extraHeaders: APP_HEADERS,
    // Sent on the last message of every stream already. Asking again would be
    // harmless and is left off so the request body says only what it means.
    requestUsage: false,
    reasoningDialect: 'reasoning-param',
    // The only target that runs tools of its own.
    serverTools: true,
    label: 'OpenRouter'
  };
}
