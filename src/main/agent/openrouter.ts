import { z } from 'zod';
import type { AgentUsage } from '../../shared/agent-types';
import type { AgentToolSpec } from '../../shared/agent-tools';
import { sseLines } from './sse';

/**
 * Minimal streaming client for OpenRouter's chat completions endpoint - just
 * enough for one round of the agent: send messages, receive content, reasoning
 * and tool calls, and the token usage the last message carries.
 */

const COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Who is asking, on every OpenRouter request Fleet makes. */
export const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/khang859/fleet',
  'X-Title': 'Fleet'
};

/** A tool call as the API states it, and as it must be echoed back. */
export type WireToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * A piece of a multi-part message. Images travel as data URLs - the endpoint is
 * remote and cannot read this disk - and OpenRouter takes png, jpeg, webp and
 * gif, which is why svg is never sent as one.
 *
 * The text goes first and the pictures after it: OpenRouter recommends that
 * order, because of how the parts are parsed on the way to the provider.
 */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * One message on the wire. The assistant's own tool calls have to be sent back
 * alongside their results, or the results are answers to questions the
 * transcript never asked.
 *
 * Only a user message may be made of parts. That is the API's rule rather than
 * ours, and it is the reason a tool that produces a picture cannot answer with
 * one: the image follows the tool result as a user message of its own.
 */
export type AgentWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireContentPart[] }
  | { role: 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

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
  /** Offered to the model when present. Omitted entirely when empty. */
  tools?: AgentToolSpec[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  /** Fires at most once, from the last message of the stream. */
  onUsage?: (usage: AgentUsage) => void;
};

/** What one completed round of the stream produced beyond its deltas. */
export type StreamOutcome = { toolCalls: WireToolCall[] };

/**
 * A tool call arrives in fragments across many chunks: the id and name in the
 * first, the arguments a few characters at a time after it. `index` is what
 * ties the fragments of one call together when the model asks for several.
 */
const toolCallDeltaSchema = z.object({
  index: z.number(),
  id: z.string().nullish(),
  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish()
});

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            tool_calls: z.array(toolCallDeltaSchema).nullish()
          })
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

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).nullish() }))
    .nullish()
});

/**
 * One call to the completions endpoint, however its body is shaped.
 *
 * Streamed and one-shot differ only in what they ask for and what they do with
 * the answer, so where to send it and how to say who is asking lives here, and
 * a response that is not an answer stops here too.
 */
async function post(
  apiKey: string,
  signal: AbortSignal | undefined,
  body: Record<string, unknown>
): Promise<Response> {
  const res = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...APP_HEADERS
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res;
}

export type CompletionRequest = {
  apiKey: string;
  model: string;
  messages: AgentWireMessage[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
};

/**
 * One completion, not streamed and without tools.
 *
 * For the work that is not a turn - naming a session - where there is nothing
 * on screen for a delta to land in, and watching a short answer arrive a word
 * at a time would be noise rather than progress.
 */
export async function completeOnce(req: CompletionRequest): Promise<string> {
  const res = await post(req.apiKey, req.signal, {
    model: req.model,
    messages: req.messages,
    stream: false,
    max_tokens: req.maxTokens,
    temperature: req.temperature
  });

  const parsed = completionSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('OpenRouter returned an unreadable completion');
  return (parsed.data.choices?.[0]?.message?.content ?? '').trim();
}

/** One fragment of a tool call, as it appeared on the wire. */
export type ToolCallDelta = {
  index: number;
  id: string | null;
  name: string | null;
  args: string;
};

/** What one SSE line carries: deltas, the end-of-stream marker, or nothing. */
export type StreamLine =
  | {
      content: string;
      reasoning: string;
      toolCalls: ToolCallDelta[];
      usage: AgentUsage | null;
    }
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
  if (!delta) {
    return usage === null ? null : { content: '', reasoning: '', toolCalls: [], usage };
  }
  return {
    content: delta.content ?? '',
    reasoning: delta.reasoning ?? '',
    toolCalls: (delta.tool_calls ?? []).map((call) => ({
      index: call.index,
      id: call.id ?? null,
      name: call.function?.name ?? null,
      args: call.function?.arguments ?? ''
    })),
    usage
  };
}

/**
 * Rebuild whole tool calls from the fragments of a stream.
 *
 * Kept apart from the reading of the stream so the reassembly - the part with
 * the edge cases in it - can be tested without a network.
 */
export function collectToolCalls(deltas: ToolCallDelta[]): WireToolCall[] {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  for (const delta of deltas) {
    const existing = byIndex.get(delta.index) ?? { id: '', name: '', args: '' };
    byIndex.set(delta.index, {
      id: delta.id ?? existing.id,
      name: delta.name ?? existing.name,
      args: existing.args + delta.args
    });
  }

  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name !== '')
    .map(([index, call]) => ({
      // A provider that streams no id still needs one to address the result to.
      id: call.id === '' ? `call_${index}` : call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args }
    }));
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

/**
 * Streams one completion, resolving when the model stops. Rejects on failure.
 *
 * Content and reasoning are handed over as they arrive; tool calls are not,
 * because half a call is not something anything can act on. They come back
 * whole, in the outcome.
 */
export async function streamCompletion(req: StreamRequest): Promise<StreamOutcome> {
  const res = await post(req.apiKey, req.signal, {
    model: req.model,
    messages: req.messages,
    stream: true,
    ...(req.maxTokens === null ? {} : { max_tokens: req.maxTokens }),
    ...(req.temperature === null ? {} : { temperature: req.temperature }),
    ...(req.reasoning === null ? {} : { reasoning: req.reasoning }),
    ...(req.tools === undefined || req.tools.length === 0 ? {} : { tools: req.tools })
  });

  if (!res.body) throw new Error('OpenRouter returned an empty response');

  const toolDeltas: ToolCallDelta[] = [];
  for await (const line of sseLines(res.body)) {
    const parsed = parseStreamLine(line);
    if (parsed === 'done') break;
    if (parsed === null) continue;
    if (parsed.content) req.onDelta(parsed.content);
    if (parsed.reasoning) req.onReasoning(parsed.reasoning);
    if (parsed.toolCalls.length > 0) toolDeltas.push(...parsed.toolCalls);
    if (parsed.usage) req.onUsage?.(parsed.usage);
  }
  return { toolCalls: collectToolCalls(toolDeltas) };
}
