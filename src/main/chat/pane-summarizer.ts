import type { OpenRouterClient } from './openrouter-client';

const SYSTEM_PROMPT =
  'You summarize the current state of a terminal pane for a scannable status list. ' +
  'Reply with ONLY one short line, at most 10 words, no quotes, no markdown, no trailing period. ' +
  "If the pane is blocked waiting on the user, prefix with 'needs input: ' followed by what it's " +
  'asking. Otherwise describe what the agent/process is doing right now.';

const MAX_LEN = 80;

/** Normalize a model-produced summary: strip quotes/markdown, collapse whitespace, cap length. */
export function sanitizeSummary(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[.]+$/, '').trim();
  if (!t) return '';
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 1).trim()}…` : t;
}

/** Ask the task model to summarize a pane's recent output. Throws on API failure. */
export async function generateSummary(
  client: OpenRouterClient,
  opts: { apiKey: string; model: string; tailText: string; signal?: AbortSignal }
): Promise<string> {
  const raw = await client.complete({
    apiKey: opts.apiKey,
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: opts.tailText || '(no output yet)' }
    ],
    maxTokens: 32,
    temperature: 0.3,
    signal: opts.signal
  });
  return sanitizeSummary(raw);
}

/** Never throws — returns '' on failure so the caller can keep the previous summary. */
export async function resolveSummary(
  client: OpenRouterClient,
  opts: { apiKey: string; model: string; tailText: string; signal?: AbortSignal }
): Promise<string> {
  try {
    return await generateSummary(client, opts);
  } catch {
    return '';
  }
}
