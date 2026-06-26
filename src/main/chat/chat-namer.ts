import type { OpenRouterClient } from './openrouter-client';

const SYSTEM_PROMPT =
  'You generate a concise title for a chat conversation. Reply with ONLY the title: ' +
  'at most 5 words, no quotes, no punctuation, no markdown, no trailing period. ' +
  'Capture the main topic.';

/**
 * Normalize a model-produced title: strip quotes/markdown/trailing punctuation,
 * collapse whitespace, cap at 5 words. Returns '' if nothing usable remains.
 */
export function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  // Drop surrounding quotes/backticks and markdown emphasis.
  t = t.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '');
  // Collapse internal whitespace/newlines.
  t = t.replace(/\s+/g, ' ').trim();
  // Strip a trailing sentence-ending punctuation mark.
  t = t.replace(/[.!?,;:]+$/, '').trim();
  if (!t) return '';
  return t.split(' ').slice(0, 5).join(' ');
}

/**
 * Last-resort title when the model is unavailable: keywords from the first line
 * of the user's message, else a dated placeholder.
 */
export function fallbackTitle(firstUser: string, now: number = Date.now()): string {
  const firstLine = firstUser.split('\n')[0]?.trim() ?? '';
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  if (words) return words.length > 48 ? `${words.slice(0, 48).trim()}…` : words;
  const date = new Date(now).toISOString().slice(0, 10);
  return `Chat — ${date}`;
}

/** Ask the task model for a title. Throws on API failure (caller falls back). */
export async function generateTitle(
  client: OpenRouterClient,
  opts: {
    apiKey: string;
    model: string;
    firstUser: string;
    firstAssistant: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  const userBlock = opts.firstAssistant
    ? `User: ${opts.firstUser}\nAssistant: ${opts.firstAssistant}`
    : `User: ${opts.firstUser}`;
  const raw = await client.complete({
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userBlock }
    ],
    maxTokens: 24,
    temperature: 0.3,
    signal: opts.signal
  });
  return sanitizeTitle(raw);
}

/**
 * Full fallback cascade: model title → first-line keywords → dated placeholder.
 * Never throws — auto-naming must never disrupt the chat.
 */
export async function resolveTitle(
  client: OpenRouterClient,
  opts: {
    apiKey: string;
    model: string;
    firstUser: string;
    firstAssistant: string;
    signal?: AbortSignal;
  }
): Promise<string> {
  try {
    const title = await generateTitle(client, opts);
    if (title) return title;
  } catch {
    // fall through to keyword/date fallback
  }
  return fallbackTitle(opts.firstUser);
}
