import type { OpenRouterClient } from './openrouter-client';

const SYSTEM_PROMPT =
  'You generate topical tags for a chat conversation. Reply with ONLY a comma-separated ' +
  'list of 1 to 3 short tags (lowercase, single words or two-word phrases, no #, no quotes). ' +
  'Capture the main topics.';

const MAX_TAGS = 3;
const MAX_TAG_LEN = 24;

/** Parse a model tag line into a clean, deduped, capped list. */
export function sanitizeTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[,\n]/)) {
    const tag = piece
      .trim()
      .toLowerCase()
      .replace(/^[#"'`*_\s-]+|["'`*_\s]+$/g, '')
      .replace(/\s+/g, ' ');
    if (!tag || tag.length > MAX_TAG_LEN || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Ask the task model for tags. Throws on API failure (caller swallows). */
export async function generateTags(
  client: OpenRouterClient,
  opts: {
    apiKey: string;
    model: string;
    firstUser: string;
    firstAssistant: string;
    signal?: AbortSignal;
  }
): Promise<string[]> {
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
  return sanitizeTags(raw);
}

/** Never throws — auto-tagging must never disrupt the chat. Returns [] on failure. */
export async function resolveTags(
  client: OpenRouterClient,
  opts: {
    apiKey: string;
    model: string;
    firstUser: string;
    firstAssistant: string;
    signal?: AbortSignal;
  }
): Promise<string[]> {
  try {
    return await generateTags(client, opts);
  } catch {
    return [];
  }
}
