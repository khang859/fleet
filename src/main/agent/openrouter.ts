import { z } from 'zod';
import type { AgentUsage } from '../../shared/agent-types';

/**
 * Minimal streaming client for OpenRouter's chat completions endpoint - just
 * enough for one turn of the agent: send messages, receive content and
 * reasoning deltas, and the token usage the last message carries. Tool calls
 * and images are not here yet.
 */

const COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_HEADERS = { 'HTTP-Referer': 'https://github.com/khang859/fleet', 'X-Title': 'Fleet' };

export type AgentWireMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** OpenRouter's `reasoning` parameter, in whichever form the model accepts. */
export type ReasoningParam = { enabled: boolean } | { effort: string } | { max_tokens: number };

export type StreamRequest = {
  apiKey: string;
  model: string;
  messages: AgentWireMessage[];
  /** Omitted from the request when null, so the model's own default applies. */
  maxTokens: number | null;
  temperature: number | null;
  reasoning: ReasoningParam | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  /** Fires at most once, from the last message of the stream. */
  onUsage?: (usage: AgentUsage) => void;
};

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: z.string().nullish(), reasoning: z.string().nullish() })
          .nullish()
      })
    )
    .nullish(),
  // OpenRouter puts usage on the final message, counted with the model's own
  // tokenizer. It used to need asking for; it is now always sent.
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number()
    })
    .nullish()
});

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

/** What one SSE line carries: deltas, the end-of-stream marker, or nothing. */
export type StreamLine =
  | { content: string; reasoning: string; usage: AgentUsage | null }
  | 'done'
  | null;

/**
 * Parse a single line of the SSE body. OpenRouter interleaves `: comment`
 * keep-alives with the data lines, and a malformed payload is skipped rather
 * than failing the turn - the stream is still likely to complete.
 */
export function parseStreamLine(line: string): StreamLine {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return null;
  if (!trimmed.startsWith('data:')) return null;

  const data = trimmed.slice('data:'.length).trim();
  if (data === '[DONE]') return 'done';

  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = chunkSchema.safeParse(json);
  if (!parsed.success) return null;

  const raw = parsed.data.usage;
  const usage: AgentUsage | null =
    raw == null
      ? null
      : {
          promptTokens: raw.prompt_tokens,
          completionTokens: raw.completion_tokens,
          totalTokens: raw.total_tokens
        };

  // The usage message carries no delta of its own on some providers, so it is
  // read before the choices are checked rather than dropped with them.
  const delta = parsed.data.choices?.[0]?.delta;
  if (!delta) return usage === null ? null : { content: '', reasoning: '', usage };
  return { content: delta.content ?? '', reasoning: delta.reasoning ?? '', usage };
}

/** The error body OpenRouter returns on a non-2xx, or a bare status line. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Fall through to the status line.
  }
  return `OpenRouter responded ${res.status}`;
}

/** Streams one completion, resolving when the model stops. Rejects on failure. */
export async function streamCompletion(req: StreamRequest): Promise<void> {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
      ...APP_HEADERS
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.maxTokens === null ? {} : { max_tokens: req.maxTokens }),
      ...(req.temperature === null ? {} : { temperature: req.temperature }),
      ...(req.reasoning === null ? {} : { reasoning: req.reasoning })
    }),
    signal: req.signal
  });

  if (!res.ok) throw new Error(await errorMessage(res));
  if (!res.body) throw new Error('OpenRouter returned an empty response');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A chunk can split a line anywhere, so the tail is held back until the
    // next read completes it.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseStreamLine(line);
      if (parsed === 'done') return;
      if (parsed === null) continue;
      if (parsed.content) req.onDelta(parsed.content);
      if (parsed.reasoning) req.onReasoning(parsed.reasoning);
      if (parsed.usage) req.onUsage?.(parsed.usage);
    }
  }
}
