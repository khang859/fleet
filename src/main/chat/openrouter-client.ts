import { z } from 'zod';
import type { ChatModel, ChatCompletionMessage } from '../../shared/chat-types';

const BASE = 'https://openrouter.ai/api/v1';
// App-attribution headers per OpenRouter convention.
const APP_HEADERS = { 'HTTP-Referer': 'https://github.com/khang859/fleet', 'X-Title': 'Fleet' };

const MODELS_SCHEMA = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().optional()
    })
  )
});

const DELTA_SCHEMA = z.object({
  error: z.object({ message: z.string() }).optional(),
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() }))
    .optional()
});

/**
 * Parse an OpenRouter SSE stream. Calls onDelta for each content fragment.
 * Resolves when the [DONE] sentinel arrives. Throws if the body carries a
 * top-level `error` (OpenRouter delivers mid-stream errors with HTTP 200).
 */
export async function consumeSSE(
  chunks: AsyncIterable<string>,
  onDelta: (delta: string) => void
): Promise<void> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '' || line.startsWith(':')) continue; // blank or keep-alive comment
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      let parsed: z.infer<typeof DELTA_SCHEMA>;
      try {
        parsed = DELTA_SCHEMA.parse(JSON.parse(data));
      } catch {
        continue; // tolerate non-JSON / unexpected shapes
      }
      if (parsed.error) throw new Error(parsed.error.message);
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) onDelta(content);
    }
  }
}

export type StreamOpts = {
  apiKey: string;
  model: string;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
};

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async listModels(apiKey: string): Promise<ChatModel[]> {
    const res = await this.fetchImpl(`${BASE}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS }
    });
    if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
    const json = MODELS_SCHEMA.parse(await res.json());
    return json.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      supportsTools: false,
      inputImage: false,
      outputImage: false
    }));
  }

  async streamCompletion(opts: StreamOpts): Promise<void> {
    const res = await this.fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
      signal: opts.signal
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter request failed: ${res.status} ${detail}`.trim());
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    async function* iterate(): AsyncIterable<string> {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    await consumeSSE(iterate(), opts.onDelta);
  }
}
