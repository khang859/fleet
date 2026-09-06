import { z } from 'zod';
import type { AgentUsage } from '../../shared/agent-types';
import type { ToolSpec } from '../../shared/agent-tools';
import {
  citationsFromResult,
  mergeCitations,
  type Citation,
  type ServerToolRecord
} from '../../shared/agent-server-tools';
import {
  IdleDeadline,
  post,
  type AgentWireMessage,
  type StreamOutcome,
  type StreamRequest,
  type WireToolCall
} from './completions';
import { modelsBody, providerBody } from '../../shared/agent-routing';
import { sseLines, sseData } from './sse';

/**
 * The Responses transport: the same round, spoken to `/responses` instead of
 * `/chat/completions`.
 *
 * It exists for one reason. `openrouter:tool_search` - the only way to stop
 * paying for tool definitions a turn never touches - is rejected with a 400 on
 * Chat Completions. It needs this endpoint. Everything else here is the cost of
 * that: a different request body, a different history format, a different
 * event set and a different usage object, all describing the same round.
 *
 * Chosen per request rather than replacing the other one. A local
 * OpenAI-compatible server has no `/responses` at all, and the great majority
 * of turns have no reason to leave the transport they have been using. See
 * `AgentService.call`.
 *
 * The reconstruction is deliberately not built out of the deltas. Every
 * terminal event carries the full `output` array - the finished items, exactly
 * as the API means them - so the deltas are used for the one thing only they
 * can do, which is showing text as it arrives, and the outcome is read off the
 * final list. A parser that reassembled items from fragments would be a second
 * implementation of something the server already did, and the two would
 * disagree on the awkward cases rather than on the easy ones.
 */

/** Where the round is sent. Relative to the target's `baseUrl`. */
const RESPONSES_PATH = '/responses';

/**
 * Where the request may go and what to try if it will not.
 *
 * The same two fields the other transport sends, under the same names. Both
 * are dropped for a target that is not OpenRouter - which cannot happen on
 * this transport today, since nothing else has a `/responses` at all, and is
 * checked anyway so that stays true rather than being remembered.
 */
function routingBody(req: StreamRequest): Record<string, unknown> {
  if (!req.target.serverTools) return {};
  const provider = req.routing === undefined ? null : providerBody(req.routing);
  const models = req.fallback === undefined ? null : modelsBody(req.fallback, req.model);
  return {
    ...(provider === null ? {} : { provider }),
    ...(models === null ? {} : { models })
  };
}

/**
 * One item in the `input` array, which is what this API calls history.
 *
 * Not messages. A round trip that was an assistant message with `tool_calls`
 * followed by two `tool` messages becomes a `function_call` item followed by
 * two `function_call_output` items, sitting at the top level beside the
 * messages rather than inside one. Reasoning is a top-level item too, and that
 * is the part that matters most to preserve: the models that stream an
 * `encrypted_content` blob use it to carry their own chain of thought between
 * rounds, and a replay that dropped it makes the model start its thinking over
 * every round.
 */
export type ResponsesItem = Record<string, unknown>;

/**
 * History, converted.
 *
 * Two shapes need care and the rest is mechanical:
 *
 * - A system message becomes a `message` item with role `system` rather than
 *   the top-level `instructions` field. `instructions` is documented as being
 *   dropped when a stored response is continued, and Fleet resends the whole
 *   transcript every round rather than continuing anything, so the field would
 *   be a second way of saying the same thing with one more way to lose it.
 * - An assistant message's `tool_calls` become `function_call` items *after*
 *   the message rather than inside it, and their results follow as
 *   `function_call_output`. The order is what pairs them: `call_id` says which
 *   output answers which call, and every call must have its output before the
 *   next assistant turn or the request is rejected.
 *
 * An assistant round that this transport produced is replayed from the items it
 * finished with rather than rebuilt from `content` and `tool_calls`. Rebuilding
 * loses the two things that only exist as items: a reasoning item's opaque
 * `encrypted_content`, which is the model's own chain of thought carried
 * between rounds, and a server tool's item, which is what an advisor's memory
 * of an earlier consultation is keyed on. Both are handed back byte for byte.
 *
 * A round that came from Chat Completions has no items, and is rebuilt the
 * mechanical way - which is right, because there was never anything more to it.
 */
export function toResponsesInput(messages: AgentWireMessage[]): ResponsesItem[] {
  const items: ResponsesItem[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content
      });
      continue;
    }
    if (message.role === 'assistant') {
      // The round as this API finished it, when this API is what ran it. Handed
      // back untouched: re-encoding is not the same bytes, and the same bytes
      // are what the replay contract asks for.
      const finished = message.response_output ?? [];
      if (finished.length > 0) {
        items.push(...finished);
        continue;
      }
      // An assistant turn that only asked for tools has no text, and an empty
      // message item is rejected rather than ignored.
      if (message.content !== '') {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }]
        });
      }
      for (const call of message.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        });
      }
      continue;
    }
    items.push({
      type: 'message',
      role: message.role,
      content:
        typeof message.content === 'string'
          ? [{ type: 'input_text', text: message.content }]
          : message.content.map((part) =>
              part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : { type: 'input_image', image_url: part.image_url.url }
            )
    });
  }
  return items;
}

/**
 * A function tool, flattened.
 *
 * Chat Completions nests the definition under a `function` key; this API puts
 * the same three fields at the top level. Nothing else differs, which is why
 * the app keeps one shape internally and converts at the wire rather than
 * carrying both.
 *
 * `defer_loading` is what makes the tool withheld until the model searches for
 * it. It is added here rather than by the caller because it is meaningless on
 * the other transport - a Chat Completions request that carried it would send
 * a field the endpoint ignores, and the tools would all load anyway with
 * nothing to say so.
 */
export function toResponsesTool(spec: ToolSpec, deferred: boolean): Record<string, unknown> {
  return {
    type: 'function',
    name: spec.function.name,
    description: spec.function.description,
    parameters: spec.function.parameters,
    ...(deferred ? { defer_loading: true } : {})
  };
}

/**
 * What one item in a finished `output` array may be.
 *
 * Everything past `type` is optional because the array holds four unrelated
 * kinds of thing and a schema that required any one field would fail the whole
 * round on the kind that does not have it. Unknown types are kept rather than
 * dropped: OpenRouter adds server tools faster than this file can follow, and
 * a record for a tool this build has not heard of should still be shown.
 *
 * Loose rather than plain for the same reason, and it is load bearing. A plain
 * `z.object` drops every key it was not told about, which here would be most of
 * what an item carries: a reasoning item's `encrypted_content`, an advisor
 * item's `instance_name`, and whatever a server tool this build has never heard
 * of states as its arguments. Those keys are exactly the ones a replay has to
 * hand back byte for byte, so a narrowing parse would quietly empty the round
 * out on its way through and leave the shape of it behind.
 */
const outputItemSchema = z.looseObject({
  type: z.string(),
  id: z.string().nullish(),
  status: z.string().nullish(),
  call_id: z.string().nullish(),
  name: z.string().nullish(),
  arguments: z.string().nullish(),
  role: z.string().nullish(),
  query: z.string().nullish(),
  result: z.unknown().nullish(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().nullish(),
        annotations: z
          .array(
            z.object({
              type: z.string().nullish(),
              url: z.string().nullish(),
              title: z.string().nullish(),
              start_index: z.number().nullish(),
              end_index: z.number().nullish()
            })
          )
          .nullish()
      })
    )
    .nullish()
});

/**
 * The usage object, which is the same accounting under different names.
 *
 * `input_tokens` where the other endpoint says `prompt_tokens`, and the cached
 * and reasoning counts one level deeper. The money fields happen to be spelled
 * the same, which is worth noticing rather than relying on - they are read
 * separately below either way.
 */
const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  cost: z.number().nullish(),
  input_tokens_details: z
    .object({
      cached_tokens: z.number().nullish(),
      cache_write_tokens: z.number().nullish()
    })
    .nullish(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
  server_tool_use: z
    .object({
      tool_calls_requested: z.number().nullish(),
      web_search_requests: z.number().nullish()
    })
    .nullish(),
  server_tool_use_details: z
    .object({
      tool_calls_requested: z.number().nullish(),
      web_search_requests: z.number().nullish()
    })
    .nullish(),
  cost_details: z.object({ server_tool_cost: z.number().nullish() }).nullish()
});

/** The response envelope, as the terminal events carry it. */
const responseSchema = z.object({
  model: z.string().nullish(),
  provider: z.string().nullish(),
  status: z.string().nullish(),
  output: z.array(outputItemSchema).nullish(),
  usage: usageSchema.nullish(),
  error: z.object({ message: z.string().nullish() }).nullish()
});

/** Every event this transport acts on. Anything else parses and is ignored. */
const eventSchema = z.object({
  type: z.string(),
  delta: z.string().nullish(),
  response: responseSchema.nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
  annotation: z
    .object({
      type: z.string().nullish(),
      url: z.string().nullish(),
      title: z.string().nullish(),
      start_index: z.number().nullish(),
      end_index: z.number().nullish()
    })
    .nullish()
});

/** The wire's account of a call, in ours. See `toUsage` in `completions.ts`. */
function toUsage(raw: z.infer<typeof usageSchema> | null | undefined): AgentUsage | null {
  if (raw == null) return null;
  const serverTools = raw.server_tool_use_details ?? raw.server_tool_use ?? null;
  return {
    promptTokens: raw.input_tokens,
    completionTokens: raw.output_tokens,
    totalTokens: raw.total_tokens,
    cachedTokens: raw.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: raw.input_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: raw.output_tokens_details?.reasoning_tokens ?? 0,
    costUsd: raw.cost ?? null,
    serverToolCalls: serverTools?.tool_calls_requested ?? 0,
    webSearches: serverTools?.web_search_requests ?? 0,
    serverToolCostUsd: raw.cost_details?.server_tool_cost ?? null
  };
}

/** The three kinds of output item this transport understands by name. */
const KNOWN_ITEMS = new Set(['message', 'reasoning', 'function_call']);

/**
 * The finished `output` array, read into the outcome the agent works in.
 *
 * Kept a pure function over the parsed items so the awkward parts - a call
 * with no `call_id`, an item type nobody has seen, an assistant message split
 * across content parts - can be tested against captured fixtures without a
 * network.
 *
 * A `function_call` becomes a `WireToolCall` and will be dispatched. Anything
 * whose type is neither a message nor reasoning nor a function call is
 * OpenRouter's own work, already finished, and becomes a `ServerToolRecord`:
 * shown, counted, and never dispatched. That test is by exclusion rather than
 * by a list of server tool names on purpose - a name this build does not
 * recognise must not fall through into the half of the code that calls
 * functions.
 */
export function collectOutput(items: Array<z.infer<typeof outputItemSchema>>): {
  toolCalls: WireToolCall[];
  serverToolCalls: ServerToolRecord[];
  citations: Citation[];
} {
  const toolCalls: WireToolCall[] = [];
  const serverToolCalls: ServerToolRecord[] = [];
  const citations: Citation[] = [];

  for (const [index, item] of items.entries()) {
    if (item.type === 'function_call') {
      toolCalls.push({
        // A call with no id still needs one to address its result to.
        id: item.call_id ?? item.id ?? `call_${index}`,
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '' }
      });
      continue;
    }
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        for (const annotation of part.annotations ?? []) {
          if (annotation.url == null) continue;
          citations.push({
            url: annotation.url,
            title: annotation.title ?? null,
            content: null,
            startIndex: annotation.start_index ?? null,
            endIndex: annotation.end_index ?? null
          });
        }
      }
      continue;
    }
    if (KNOWN_ITEMS.has(item.type)) continue;
    // Everything left is work OpenRouter did on its own side. The arguments it
    // states vary by tool - a search says `query`, a fetch says `url` - so the
    // whole item minus its bookkeeping is kept as the arguments rather than
    // guessing which key mattered.
    const { type, id, status, result, ...args } = item;
    void type;
    void id;
    void status;
    const resultJson = result == null ? '' : JSON.stringify(result);
    serverToolCalls.push({
      callId: item.id ?? null,
      toolName: item.type,
      args: JSON.stringify(args),
      result: resultJson,
      citations: citationsFromResult(resultJson)
    });
  }

  return {
    toolCalls: toolCalls.filter((call) => call.function.name !== ''),
    serverToolCalls,
    citations
  };
}

/**
 * Streams one round against the Responses API, resolving when the model stops.
 *
 * Signature-compatible with `streamCompletion` so the two are
 * interchangeable at the one place that chooses between them.
 */
export async function streamResponse(req: StreamRequest): Promise<StreamOutcome> {
  const deadline = new IdleDeadline(req.signal, req.target.label);
  try {
    // The same rule Chat Completions follows: a stop condition goes only where
    // server tools went, since on its own it is a rule about a loop that will
    // never run. Left off, the spend brake and the step ceiling the user
    // configured simply do not apply to a deferred turn - the two settings
    // would be on screen and doing nothing.
    //
    // The endpoint parses this rather than ignoring it: an invented condition
    // type comes back 400 naming `step_count_is`, `has_tool_call`,
    // `max_tokens_used`, `max_cost` and `finish_reason_is` as the ones it
    // knows, which is the set `serverToolStops` already builds from.
    const server = req.serverTools ?? [];
    const stops = server.length === 0 ? null : (req.serverToolStops ?? null);
    const tools = [
      // Server tools first, for the reason `toolsBody` gives: an advisor's
      // position in this array is what its own memory is keyed on, and the
      // function half of the list is not stable across a conversation.
      ...server,
      ...(req.tools ?? []).map((spec) => toResponsesTool(spec, false)),
      ...(req.deferredTools ?? []).map((spec) => toResponsesTool(spec, true))
    ];
    const res = await post(req.target, req.signal, deadline, RESPONSES_PATH, {
      model: req.model,
      input: toResponsesInput(req.messages),
      stream: true,
      // Nothing is kept on OpenRouter's side. Fleet resends the whole
      // transcript every round, so a stored response would be a second copy of
      // the conversation living somewhere the user cannot see or delete.
      store: false,
      ...(req.maxTokens === null ? {} : { max_output_tokens: req.maxTokens }),
      ...(req.temperature === null ? {} : { temperature: req.temperature }),
      ...(req.reasoning === null ? {} : { reasoning: req.reasoning }),
      ...(tools.length === 0 ? {} : { tools }),
      ...(stops === null || stops.length === 0 ? {} : { stop_server_tools_when: stops }),
      // Routing preferences and fallbacks are top-level fields under the same
      // names on both endpoints, so they carry over unchanged.
      //
      // Cache breakpoints deliberately do not. The marker rides on a message
      // content part, and this endpoint's parts are `input_text` rather than
      // `text` - a shape that has not been checked against a real request, and
      // an unrecognised key here is a 400 rather than something ignored. A
      // turn with deferral on therefore gets no explicit caching. Worth fixing
      // by capturing a request the way the rest of this file was written.
      ...routingBody(req)
      // `tool_choice` is deliberately never sent. With deferral active the API
      // accepts it only as `auto` or `allowed_tools` and 400s on anything else,
      // and Fleet has never had a reason to send it. Written down so that stays
      // a decision rather than an accident.
    });

    if (!res.body) throw new Error(`${req.target.label} returned an empty response`);

    let final: z.infer<typeof responseSchema> | null = null;
    const annotated: Citation[] = [];
    let failure: string | null = null;

    for await (const line of sseLines(res.body)) {
      deadline.touch();
      const data = sseData(line);
      if (data === null) continue;
      const parsed = eventSchema.safeParse(data);
      if (!parsed.success) continue;
      const event = parsed.data;

      if (event.type === 'response.output_text.delta') {
        if (event.delta != null) req.onDelta(event.delta);
        continue;
      }
      // Both channels a model may think out loud on. Which one arrives is the
      // provider's choice, and a model that sends both sends different text on
      // each rather than the same text twice.
      if (
        event.type === 'response.reasoning_text.delta' ||
        event.type === 'response.reasoning_summary_text.delta'
      ) {
        if (event.delta != null) req.onReasoning(event.delta);
        continue;
      }
      if (event.type === 'response.output_text.annotation.added') {
        const annotation = event.annotation;
        if (annotation?.url != null) {
          annotated.push({
            url: annotation.url,
            title: annotation.title ?? null,
            content: null,
            startIndex: annotation.start_index ?? null,
            endIndex: annotation.end_index ?? null
          });
        }
        continue;
      }
      if (event.type === 'error') {
        failure = event.error?.message ?? `${req.target.label} reported an error`;
        continue;
      }
      if (event.type === 'response.failed') {
        failure = event.response?.error?.message ?? `${req.target.label} could not answer`;
        continue;
      }
      // `completed` and `incomplete` both carry the whole output. An incomplete
      // round is not an error: it ran out of its token budget mid-answer, and
      // what it did produce is worth keeping and showing.
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        final = event.response ?? null;
      }
    }

    if (failure !== null) throw new Error(failure);
    if (final === null) throw new Error(`${req.target.label} ended without an answer`);

    const usage = toUsage(final.usage);
    if (usage !== null) req.onUsage?.(usage);

    const collected = collectOutput(final.output ?? []);
    return {
      toolCalls: collected.toolCalls,
      serverToolCalls: collected.serverToolCalls,
      citations: mergeCitations(
        annotated,
        collected.citations,
        ...collected.serverToolCalls.map((call) => call.citations)
      ),
      // The round as the API finished it, so the next request can hand it back
      // rather than describe it. Parsed rather than raw only in the sense that
      // zod validated the envelope - the items themselves are passed through.
      outputItems: final.output ?? [],
      model: final.model ?? null,
      provider: final.provider ?? null
    };
  } finally {
    deadline.clear();
  }
}
