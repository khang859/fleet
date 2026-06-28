import { z } from 'zod';
import type { ChatModel, ChatMessageUsage } from '../../shared/chat-types';

const BASE = 'https://openrouter.ai/api/v1';
// App-attribution headers per OpenRouter convention.
const APP_HEADERS = { 'HTTP-Referer': 'https://github.com/khang859/fleet', 'X-Title': 'Fleet' };

const MODELS_SCHEMA = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().optional(),
      supported_parameters: z.array(z.string()).optional(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()).optional(),
          output_modalities: z.array(z.string()).optional()
        })
        .optional()
    })
  )
});

export type ToolCall = { id: string; name: string; arguments: string };
export type StreamResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** Accounting from the final SSE chunk (OpenRouter `usage: {include:true}`); null/absent otherwise. */
  usage?: ChatMessageUsage | null;
};

/** OpenRouter usage block, present on the terminal SSE chunk when accounting is enabled. */
const USAGE_SCHEMA = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  cost: z.number().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish()
});

function toUsage(u: z.infer<typeof USAGE_SCHEMA>): ChatMessageUsage {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cost: u.cost ?? null
  };
}

const COMPLETION_SCHEMA = z.object({
  error: z.object({ message: z.string() }).optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).optional() }))
    .optional()
});

const TOOLCALL_DELTA_SCHEMA = z.object({
  error: z.object({ message: z.string() }).optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            // Reasoning tokens: OpenRouter normalizes to `reasoning`; some providers
            // pass through `reasoning_content`. Accept both, prefer `reasoning`.
            reasoning: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional()
                })
              )
              .optional()
          })
          .optional(),
        finish_reason: z.string().nullish()
      })
    )
    .optional(),
  usage: USAGE_SCHEMA.nullish()
});

/**
 * Parse an OpenRouter SSE stream. Calls onDelta for each content fragment and
 * onReasoning for each chain-of-thought fragment. Assembles tool_calls by index.
 * Resolves with content, toolCalls, and finishReason when the [DONE]
 * sentinel arrives or the stream ends (reasoning is delivered only via onReasoning).
 * Throws if the body carries a top-level `error` (OpenRouter delivers mid-stream errors with HTTP 200).
 */
export async function consumeSSE(
  chunks: AsyncIterable<string>,
  onDelta: (delta: string) => void,
  onReasoning: (delta: string) => void = () => {}
): Promise<StreamResult> {
  let buffer = '';
  let content = '';
  let finishReason: string | null = null;
  let usage: ChatMessageUsage | null = null;
  const calls: Array<{ id: string; name: string; args: string }> = [];

  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '' || line.startsWith(':')) continue; // blank or keep-alive comment
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        return { content, toolCalls: toToolCalls(calls), finishReason, usage };
      }
      let parsed: z.infer<typeof TOOLCALL_DELTA_SCHEMA>;
      try {
        parsed = TOOLCALL_DELTA_SCHEMA.parse(JSON.parse(data));
      } catch {
        continue; // tolerate non-JSON / unexpected shapes
      }
      if (parsed.error) throw new Error(parsed.error.message);
      if (parsed.usage) usage = toUsage(parsed.usage);
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content;
      if (reasoningDelta) onReasoning(reasoningDelta);
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, toolCalls: toToolCalls(calls), finishReason, usage };
}

function toToolCalls(calls: Array<{ id: string; name: string; args: string }>): ToolCall[] {
  return calls.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, arguments: c.args }));
}

export type StreamOpts = {
  apiKey: string;
  model: string;
  messages: unknown[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  /** Receives chain-of-thought fragments (the `reasoning` SSE field); optional. */
  onReasoning?: (delta: string) => void;
  tools?: unknown[];
  toolChoice?: 'auto' | 'none';
  /** OpenRouter plugins (e.g. the file-parser for PDF attachments). */
  plugins?: unknown[];
};

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private mapModels(json: z.infer<typeof MODELS_SCHEMA>): ChatModel[] {
    return json.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      supportsTools: m.supported_parameters?.includes('tools') ?? false,
      inputImage: m.architecture?.input_modalities?.includes('image') ?? false,
      outputImage: m.architecture?.output_modalities?.includes('image') ?? false
    }));
  }

  async listModels(apiKey: string): Promise<ChatModel[]> {
    const res = await this.fetchImpl(`${BASE}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS }
    });
    if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
    return this.mapModels(MODELS_SCHEMA.parse(await res.json()));
  }

  async listImageModels(apiKey: string): Promise<ChatModel[]> {
    const res = await this.fetchImpl(`${BASE}/models?output_modalities=image`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS }
    });
    if (!res.ok) throw new Error(`OpenRouter image /models failed: ${res.status}`);
    return this.mapModels(MODELS_SCHEMA.parse(await res.json())).filter((m) => m.outputImage);
  }

  /**
   * One-shot, non-streaming completion. Used by the "task model" code path
   * (auto-naming, query generation) — a cheap model decoupled from the chat
   * model. Returns the assistant message text (trimmed); empty string if the
   * model produced none.
   */
  async complete(opts: {
    apiKey: string;
    model: string;
    messages: unknown[];
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false
    };
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;
    const res = await this.fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify(body),
      signal: opts.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter completion failed: ${res.status} ${detail}`.trim());
    }
    const parsed = COMPLETION_SCHEMA.parse(await res.json());
    if (parsed.error) throw new Error(parsed.error.message);
    return (parsed.choices?.[0]?.message?.content ?? '').trim();
  }

  async streamCompletion(opts: StreamOpts): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      // Ask OpenRouter to include token counts + cost in the terminal SSE chunk.
      usage: { include: true }
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? 'auto';
    }
    if (opts.plugins?.length) body.plugins = opts.plugins;
    const res = await this.fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify(body),
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
    return consumeSSE(iterate(), opts.onDelta, opts.onReasoning);
  }
}
