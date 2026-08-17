import { z } from 'zod';
import type { AgentUsage } from '../../shared/agent-types';
import type { ToolSpec } from '../../shared/agent-tools';
import { sseLines } from './sse';

/**
 * Minimal streaming client for a chat completions endpoint - just enough for
 * one round of the agent: send messages, receive content, reasoning and tool
 * calls, and the token usage the last message carries.
 *
 * Speaks to OpenRouter and to whatever OpenAI-compatible server the user is
 * running on their own machine - `llama-server`, Ollama, LM Studio, vLLM - and
 * the difference between them is entirely contained in the `CompletionsTarget`
 * a caller hands over. There is no dialect switch and no per-provider branch in
 * this file, because measured against four real servers there was nothing left
 * to branch on: the four things that genuinely vary are all data, and they are
 * the four fields of that record.
 */

/**
 * How long a call may go silent before it is given up on.
 *
 * Idle rather than total: a stream that is arriving is not stuck however long
 * it has been running, and a long answer from a slow reasoning model is the
 * ordinary case rather than the failure. What this catches is the other one -
 * a connection that was accepted and then never said anything - which without
 * a clock of its own hangs forever. That is not only a pane that never
 * finishes: a subagent stuck here holds one of the five slots the whole app
 * shares, so one dead socket can stop every other conversation dispatching.
 */
const IDLE_TIMEOUT_MS = 90_000;

/** Attempts a request gets when the far end is busy or broken. */
const MAX_ATTEMPTS = 3;

/** How long to wait before the second attempt, doubling, if the server did not say. */
const BACKOFF_MS = 1_000;

/**
 * Statuses worth asking again about.
 *
 * The far end is busy or briefly broken in every one of these, so the same
 * request may well work in a second. Everything else - a bad key, a model that
 * does not exist, a body the API would not take - will fail exactly the same
 * way next time, and retrying it only makes the user wait longer to be told.
 */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A signal that fires when the caller cancels, and also when nothing has
 * happened for a while.
 *
 * The clock is restarted rather than run once, because a call has two different
 * silences to survive: the wait for the first byte, and the pauses between
 * chunks once the stream is running. A single deadline over the whole thing
 * would cut off a long answer that was arriving perfectly well.
 */
class IdleDeadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unlink: (() => void) | null = null;

  constructor(
    caller: AbortSignal | undefined,
    private readonly label = 'The model'
  ) {
    if (caller !== undefined) {
      if (caller.aborted) this.controller.abort(caller.reason);
      else {
        const relay = (): void => this.controller.abort(caller.reason);
        caller.addEventListener('abort', relay, { once: true });
        this.unlink = () => caller.removeEventListener('abort', relay);
      }
    }
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Something arrived. Start the clock again. */
  touch(): void {
    this.hold();
    this.timer = setTimeout(
      () => this.controller.abort(new Error(`${this.label} stopped responding.`)),
      IDLE_TIMEOUT_MS
    );
  }

  /** Stop the clock without ending the call: waiting to retry is not silence. */
  hold(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The call is over, one way or another. */
  clear(): void {
    this.hold();
    this.unlink?.();
    this.unlink = null;
  }
}

/**
 * Where one call goes, and how to be let in.
 *
 * A record rather than an interface with implementations behind it. The whole
 * of what differs between OpenRouter and a `llama-server` on loopback is here:
 * an address, whether there is a key, two headers OpenRouter asks for, and
 * whether usage has to be requested. A class hierarchy over four scalars would
 * be dispatch machinery wrapped around a decision nobody has to make.
 */
export type CompletionsTarget = {
  /** Origin plus api prefix, e.g. `http://127.0.0.1:11437/v1`. No trailing slash. */
  baseUrl: string;
  /** `null` sends no `Authorization` at all - the ordinary local case. */
  apiKey: string | null;
  /** OpenRouter's attribution headers. Empty for a server on this machine. */
  extraHeaders: Record<string, string>;
  /**
   * Whether to ask for token usage explicitly.
   *
   * OpenRouter sends it on the last message of every stream without being
   * asked. An OpenAI-compatible server sends it only when the request carries
   * `stream_options.include_usage`, and a stream without it is not an error -
   * it just silently accounts for nothing, leaving the context meter empty and
   * the spend meter blank for the whole conversation.
   */
  requestUsage: boolean;
  /**
   * How this endpoint is told whether to think.
   *
   * `reasoning` is OpenRouter's own parameter and every other server ignores
   * it - not with an error, which is what makes this worth a field. A short
   * call that asks a thinking model for six words comes back empty, having
   * spent the whole budget reasoning, and the caller reads that as "the model
   * had nothing to say": naming a session silently stops working, and every
   * command in auto mode falls back to asking the user. `llama-server` and the
   * servers that follow it take the flag through the chat template instead.
   */
  reasoningDialect: 'reasoning-param' | 'chat-template-kwargs';
  /**
   * What to call this endpoint when a message about it reaches the user.
   *
   * Every sentence this file can produce ends up on screen, and "OpenRouter
   * stopped responding" is actively misleading about a request that never left
   * the machine.
   */
  label: string;
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

/**
 * The reasoning ask, in the dialect this endpoint speaks.
 *
 * Only the on/off part survives translation, and only that part has to. The
 * chat templates that read `enable_thinking` read nothing else - there is no
 * effort level and no thinking budget on that side - so an effort or a token
 * count asked of a local model comes out as nothing said, which leaves the
 * model's own default in place. That is the honest answer: Fleet has no way to
 * turn "high" into a setting a `llama-server` would recognise.
 *
 * A caller that says nothing gets nothing sent, on either side, so the case
 * where a model's default should stand stays a case where it does.
 */
function reasoningBody(
  reasoning: ReasoningParam | null,
  dialect: CompletionsTarget['reasoningDialect']
): Record<string, unknown> {
  if (reasoning === null) return {};
  if (dialect === 'reasoning-param') return { reasoning };
  if (!('enabled' in reasoning)) return {};
  return { chat_template_kwargs: { enable_thinking: reasoning.enabled } };
}

export type StreamRequest = {
  target: CompletionsTarget;
  model: string;
  messages: AgentWireMessage[];
  /** Omitted from the request when null, so the model's own default applies. */
  maxTokens: number | null;
  temperature: number | null;
  reasoning: ReasoningParam | null;
  /** Offered to the model when present. Omitted entirely when empty. */
  tools?: ToolSpec[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  /** Fires at most once, from the last message of the stream. */
  onUsage?: (usage: AgentUsage) => void;
};

/**
 * What one completed round of the stream produced beyond its deltas.
 *
 * Who served it comes back here rather than through `onUsage`, because it is
 * not usage and because it is stated on every chunk rather than on the last
 * one - the two facts arrive by different routes and are only put together
 * once the round is over.
 */
export type StreamOutcome = {
  toolCalls: WireToolCall[];
  model: string | null;
  provider: string | null;
};

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

/**
 * What OpenRouter says a call cost, counted with the model's own tokenizer.
 *
 * It used to need asking for; it is now always sent, on the final message of a
 * stream and on the body of a one-shot completion alike. Everything past the
 * three counts is `nullish`, and not because it is optional to us: OpenRouter
 * routes to a hundred providers, and which of them report caching, reasoning
 * or a price at all is theirs to decide. A schema that required any of it
 * would fail the whole turn's accounting on the provider that happened to be
 * quiet.
 */
const usageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  /** USD charged. The number the user's invoice will agree with. */
  cost: z.number().nullish(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().nullish(),
      cache_write_tokens: z.number().nullish()
    })
    .nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish()
});

/**
 * The wire's account of a call, in ours.
 *
 * The unstated counts read as zero and the unstated price reads as unknown,
 * which is the one asymmetry worth keeping straight: a provider silent about
 * caching cached nothing as far as anyone can tell, but a provider silent
 * about money has not told us it was free.
 */
function toUsage(raw: z.infer<typeof usageSchema> | null | undefined): AgentUsage | null {
  if (raw == null) return null;
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: raw.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
    costUsd: raw.cost ?? null
  };
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning: z.string().nullish(),
            /**
             * The same thing under the name llama.cpp gives it. Read
             * unconditionally rather than behind a dialect flag: no server
             * sends both, so accepting either costs nothing and saves the whole
             * client from having to know who it is talking to. Without this a
             * local reasoning model's thinking is parsed and then dropped, and
             * the pane shows an empty reply while the model works.
             */
            reasoning_content: z.string().nullish(),
            tool_calls: z.array(toolCallDeltaSchema).nullish()
          })
          .nullish()
      })
    )
    .nullish(),
  usage: usageSchema.nullish(),
  // Which model and upstream actually served this. Not usage, but the answer to
  // the question the cost provokes - and the only place it is ever stated,
  // since `:auto` and a provider fallback both mean the model that replied is
  // not necessarily the one that was asked for.
  model: z.string().nullish(),
  provider: z.string().nullish()
});

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).nullish() }))
    .nullish(),
  usage: usageSchema.nullish()
});

/**
 * One call to the completions endpoint, however its body is shaped.
 *
 * Streamed and one-shot differ only in what they ask for and what they do with
 * the answer, so where to send it and how to say who is asking lives here, and
 * a response that is not an answer stops here too.
 *
 * This is also the only place in the file that retries, and it is the only
 * place that safely can: nothing has read the body yet, so asking again cannot
 * repeat a word the user has already watched arrive. Once `streamCompletion`
 * has handed over its first delta the round is committed, and a failure after
 * that is the caller's to report rather than ours to paper over.
 */
async function post(
  target: CompletionsTarget,
  caller: AbortSignal | undefined,
  deadline: IdleDeadline,
  body: Record<string, unknown>
): Promise<Response> {
  const payload = JSON.stringify(body);
  let wait = BACKOFF_MS;

  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === MAX_ATTEMPTS;
    deadline.touch();

    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          // Omitted rather than sent empty when there is no key. A local server
          // started without `--api-key` ignores the header either way, but one
          // started *with* one rejects a malformed bearer instead of reading it
          // as absent, which turns "no key needed" into a 401.
          ...(target.apiKey === null ? {} : { Authorization: `Bearer ${target.apiKey}` }),
          'Content-Type': 'application/json',
          ...target.extraHeaders
        },
        body: payload,
        signal: deadline.signal
      });
    } catch (err) {
      // A user who pressed stop has been answered, not failed. Anything else -
      // a dropped connection, a socket that went quiet - is worth one more try.
      if (caller?.aborted === true || last) throw err;
      await backoff(wait, deadline);
      wait *= 2;
      continue;
    }

    if (res.ok) return res;
    const message = await errorMessage(res, target.label);
    if (last || !RETRY_STATUS.has(res.status)) throw new Error(message);
    await backoff(retryAfterMs(res) ?? wait, deadline);
    wait *= 2;
  }
}

/** Wait before asking again, with the clock stopped: a wait is not a silence. */
async function backoff(ms: number, deadline: IdleDeadline): Promise<void> {
  deadline.hold();
  await new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    deadline.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true }
    );
  });
}

/**
 * How long the server asked to be left alone for, in milliseconds.
 *
 * A rate limit that states its own window is the one number here worth more
 * than our guess, since it is the only one that knows when the quota turns
 * over. Only the seconds form is read: the HTTP-date form is legal and nobody
 * sends it, and a clock-skewed parse would be worse than the fallback.
 */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // Capped, because a limit that resets in an hour is not something to sit and
  // wait out with a spinner on screen - it is something to tell the user about.
  return Math.min(seconds, 30) * 1000;
}

export type CompletionRequest = {
  target: CompletionsTarget;
  model: string;
  messages: AgentWireMessage[];
  maxTokens: number;
  temperature: number;
  /**
   * Omitted from the request when null, so the model's own default applies -
   * which on a reasoning model means thinking. Everything that calls this wants
   * a handful of tokens back, so leaving it null spends the whole budget on
   * reasoning and returns empty content. Stated rather than defaulted for that
   * reason: a caller asking for 8 tokens should have to say what it wants here.
   */
  reasoning: ReasoningParam | null;
  signal?: AbortSignal;
};

/**
 * One completion, not streamed and without tools.
 *
 * For the work that is not a turn - naming a session - where there is nothing
 * on screen for a delta to land in, and watching a short answer arrive a word
 * at a time would be noise rather than progress. It is still a call to a model
 * and is still billed, so it still comes back with what it cost.
 */
export async function completeOnce(
  req: CompletionRequest
): Promise<{ text: string; usage: AgentUsage | null }> {
  const deadline = new IdleDeadline(req.signal, req.target.label);
  try {
    const res = await post(req.target, req.signal, deadline, {
      model: req.model,
      messages: req.messages,
      stream: false,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...reasoningBody(req.reasoning, req.target.reasoningDialect)
    });

    const parsed = completionSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`${req.target.label} returned an unreadable completion`);
    return {
      text: (parsed.data.choices?.[0]?.message?.content ?? '').trim(),
      usage: toUsage(parsed.data.usage)
    };
  } finally {
    deadline.clear();
  }
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
      /** Stated on every chunk, so the last one to say wins - they agree. */
      model: string | null;
      provider: string | null;
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

  const usage = toUsage(parsed.data.usage);
  const served = {
    model: parsed.data.model ?? null,
    provider: parsed.data.provider ?? null
  };

  // The usage message carries no delta of its own on some providers, so it is
  // read before the choices are checked rather than dropped with them.
  const delta = parsed.data.choices?.[0]?.delta;
  if (!delta) {
    return usage === null ? null : { content: '', reasoning: '', toolCalls: [], usage, ...served };
  }
  return {
    content: delta.content ?? '',
    reasoning: delta.reasoning ?? delta.reasoning_content ?? '',
    toolCalls: (delta.tool_calls ?? []).map((call) => ({
      index: call.index,
      id: call.id ?? null,
      name: call.function?.name ?? null,
      args: call.function?.arguments ?? ''
    })),
    usage,
    ...served
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

/**
 * The error body returned on a non-2xx, or a bare status line.
 *
 * `{ error: { message } }` is OpenAI's envelope rather than OpenRouter's own,
 * so the same parse serves every server here - llama.cpp answers a bad request
 * in exactly this shape.
 */
async function errorMessage(res: Response, label: string): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Fall through to the status line.
  }
  return `${label} responded ${res.status}`;
}

/**
 * Streams one completion, resolving when the model stops. Rejects on failure.
 *
 * Content and reasoning are handed over as they arrive; tool calls are not,
 * because half a call is not something anything can act on. They come back
 * whole, in the outcome.
 */
export async function streamCompletion(req: StreamRequest): Promise<StreamOutcome> {
  const deadline = new IdleDeadline(req.signal, req.target.label);
  try {
    const res = await post(req.target, req.signal, deadline, {
      model: req.model,
      messages: req.messages,
      stream: true,
      // Asked for only where it has to be. OpenRouter sends usage on the last
      // message regardless; an OpenAI-compatible server sends none without
      // this, and the silence is indistinguishable from a turn that cost
      // nothing - so the meters would read zero rather than read as broken.
      ...(req.target.requestUsage ? { stream_options: { include_usage: true } } : {}),
      ...(req.maxTokens === null ? {} : { max_tokens: req.maxTokens }),
      ...(req.temperature === null ? {} : { temperature: req.temperature }),
      ...reasoningBody(req.reasoning, req.target.reasoningDialect),
      ...(req.tools === undefined || req.tools.length === 0 ? {} : { tools: req.tools })
    });

    if (!res.body) throw new Error(`${req.target.label} returned an empty response`);

    const toolDeltas: ToolCallDelta[] = [];
    const served: { model: string | null; provider: string | null } = {
      model: null,
      provider: null
    };
    for await (const line of sseLines(res.body)) {
      // Every line, including the keep-alive comments that parse to nothing.
      // Those are exactly what says the connection is alive while a reasoning
      // model thinks, and a clock that ignored them would cut off the models
      // that take longest - the ones worth waiting for.
      deadline.touch();
      const parsed = parseStreamLine(line);
      if (parsed === 'done') break;
      if (parsed === null) continue;
      if (parsed.content) req.onDelta(parsed.content);
      if (parsed.reasoning) req.onReasoning(parsed.reasoning);
      if (parsed.toolCalls.length > 0) toolDeltas.push(...parsed.toolCalls);
      if (parsed.usage) req.onUsage?.(parsed.usage);
      if (parsed.model !== null) served.model = parsed.model;
      if (parsed.provider !== null) served.provider = parsed.provider;
    }
    return { toolCalls: collectToolCalls(toolDeltas), ...served };
  } finally {
    deadline.clear();
  }
}
