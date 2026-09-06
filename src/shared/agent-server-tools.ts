import { z } from 'zod';

/**
 * Tools OpenRouter runs on its own side, and the records they leave behind.
 *
 * A server tool is not a tool in the sense the rest of this app means the word.
 * Nothing here is dispatched, permission-gated, or run against the user's
 * folder: the model asks, OpenRouter answers, and Fleet is told afterwards what
 * happened. That distinction is the whole reason this file exists apart from
 * `agent-tools.ts` - the two kinds travel in the same `tools` array on the wire
 * and must never mix anywhere else, because a server tool that reached local
 * dispatch would be a call to a function that does not exist, and a local tool
 * that reached OpenRouter's executor would be a call it cannot make.
 *
 * The types are kept structural rather than closed over a list of tool names.
 * OpenRouter marks the whole feature beta and adds tools to it faster than any
 * enum here could follow, and a record that arrives for a tool this build has
 * never heard of should still be shown and still be replayed rather than
 * dropped for failing a parse.
 */

/** What marks a wire tool as OpenRouter's rather than one Fleet can run. */
export const SERVER_TOOL_PREFIX = 'openrouter:';

/**
 * Whether a name on the wire belongs to OpenRouter's executor.
 *
 * The guard local dispatch checks before it goes looking for a function. On
 * Chat Completions server-tool work is reported through `reasoning_details`
 * rather than `tool_calls`, so in the ordinary case this never fires - it is
 * here for the case where that stops being true, which for a beta API is worth
 * one line of defence rather than a bug report about a tool nobody wrote.
 */
export function isServerToolName(name: string): boolean {
  return name.startsWith(SERVER_TOOL_PREFIX);
}

/**
 * One server tool, as the request states it.
 *
 * `parameters` is the tool's own configuration - not a JSON Schema, which is
 * what the same key means on a function tool. They collide because OpenRouter
 * chose the same word for both; nothing can be done about that except to say so
 * here, where somebody reading `ToolSpec` next to this will wonder.
 */
export type ServerToolSpec = {
  type: string;
  parameters?: Record<string, unknown>;
};

/**
 * A condition that ends OpenRouter's own loop.
 *
 * Sent as an array, and the array is read as "whichever fires first". Supplying
 * it replaces `max_tool_calls` outright rather than narrowing it, which is why
 * anything that sets a spend cap has to restate the step cap alongside it - a
 * request that asks only for a spend stop has silently given up the 30-step
 * default and can loop far longer than its author expected.
 *
 * A spend stop is a threshold rather than a ceiling. The documented behaviour on
 * crossing it is to finish the calls already in flight and take one more turn to
 * answer, so the figure on the invoice is above the number sent here. It is a
 * brake, not a limit, and nothing should be described to the user as a cap.
 */
export type ServerToolStop =
  | { type: 'step_count_is'; step_count: number }
  | { type: 'max_cost'; max_cost_in_dollars: number }
  | { type: 'max_tokens_used'; max_tokens: number }
  | { type: 'has_tool_call'; tool_name: string }
  | { type: 'finish_reason_is'; reason: string };

/**
 * The stop conditions for one turn, or nothing when the defaults will do.
 *
 * Returns `null` rather than an empty array when there is no spend cap, so the
 * request omits the field and keeps OpenRouter's 30-step default instead of
 * restating it. Sending a step condition that says exactly what the default says
 * would be noise in the body and one more number to keep in step with theirs.
 */
export function serverToolStops(options: {
  steps: number;
  maxSpendUsd: number | null;
}): ServerToolStop[] | null {
  if (options.maxSpendUsd === null) return null;
  return [
    { type: 'step_count_is', step_count: options.steps },
    { type: 'max_cost', max_cost_in_dollars: options.maxSpendUsd }
  ];
}

/**
 * One page a search or a fetch found, as it is shown and stored.
 *
 * `content` is the excerpt OpenRouter passed to the model rather than the page:
 * what the answer was actually based on, which is the only version of it worth
 * keeping. The indexes are into the message the citation belongs to, and are
 * `null` far more often than not - most providers state the source without
 * saying which sentence it backs.
 */
export type Citation = {
  url: string;
  title: string | null;
  content: string | null;
  startIndex: number | null;
  endIndex: number | null;
};

/**
 * Work OpenRouter did, as a completed fact.
 *
 * There is no in-progress form of this and there deliberately is not one. On
 * Chat Completions the record arrives already carrying its result, so a row that
 * showed a spinner would be showing one for something that finished before the
 * bytes left OpenRouter. The pane draws these as history, in the round they
 * belong to.
 *
 * `args` and `result` stay as the JSON strings the wire used. Both are replayed
 * verbatim on later requests - that is what lets an advisor recall an earlier
 * consultation - and a value re-encoded through a parse is not verbatim.
 */
export type ServerToolRecord = {
  /** OpenRouter's id for the call, when it stated one. */
  callId: string | null;
  /** e.g. `openrouter:web_search`. */
  toolName: string;
  args: string;
  result: string;
  /** Pages this call found, when it was the kind of call that finds pages. */
  citations: Citation[];
};

/** One cited page as it is written to a session file and read back. */
export const CitationSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  content: z.string().nullable(),
  startIndex: z.number().nullable(),
  endIndex: z.number().nullable()
});

/** A server-tool record as it is written to a session file and read back. */
export const ServerToolCallSchema = z.object({
  callId: z.string().nullable(),
  toolName: z.string(),
  args: z.string(),
  result: z.string(),
  citations: z.array(CitationSchema).default([])
});

/**
 * The short name a person reads, from the wire name.
 *
 * `openrouter:web_search` is how the API spells it and is not how anybody
 * describes what happened, so the prefix comes off and the underscore becomes a
 * space. An unknown tool still renders as something legible rather than as a
 * blank, which is the point of doing this by rule instead of by lookup table.
 */
export function serverToolLabel(toolName: string): string {
  const bare = toolName.startsWith(SERVER_TOOL_PREFIX)
    ? toolName.slice(SERVER_TOOL_PREFIX.length)
    : toolName;
  return bare.replace(/_/g, ' ');
}

/**
 * The query a search record was made from, when it can be read out of it.
 *
 * Best effort by design: the arguments are the model's own JSON and may be
 * malformed, and the key it uses is the provider's choice rather than a promise
 * OpenRouter makes. A row that cannot name its query says so by rendering
 * without one, which is better than a row that refuses to render.
 */
export function serverToolQuery(args: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return null;
  }
  const parsed = queryArgsSchema.safeParse(json);
  if (!parsed.success) return null;
  for (const key of ['query', 'q', 'search_query', 'prompt', 'url'] as const) {
    const value = parsed.data[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Every key a provider has been seen to put the query under. */
const queryArgsSchema = z.object({
  query: z.string().nullish(),
  q: z.string().nullish(),
  search_query: z.string().nullish(),
  prompt: z.string().nullish(),
  url: z.string().nullish()
});

/**
 * The shapes a search result has been seen to come back in.
 *
 * Three of them, because the result is passed through from whichever engine ran
 * the search rather than normalised by OpenRouter: a bare array, an object with
 * `results`, or one with `citations`. Everything inside is optional except the
 * url, since a source without an address is not a source anyone can follow.
 */
const searchResultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  content: z.string().nullish(),
  text: z.string().nullish(),
  snippet: z.string().nullish()
});

const searchPayloadSchema = z.union([
  z.array(searchResultSchema),
  z.object({ results: z.array(searchResultSchema) }),
  z.object({ citations: z.array(searchResultSchema) })
]);

/**
 * The pages named inside a server tool's own result.
 *
 * The second of the two routes a citation can arrive by, and the one that does
 * not depend on the model choosing to cite. `annotations` are attached to the
 * assistant's text and only appear when the provider ties a sentence to a
 * source; the result payload lists everything the search actually returned. A
 * turn where the model read five pages and cited one should show five.
 *
 * Both routes are read and the two are merged, because neither is reliably
 * present: the Chat API reference does not list `annotations` on the stream
 * delta at all, while the feature guide documents them on the message.
 */
export function citationsFromResult(result: string): Citation[] {
  let json: unknown;
  try {
    json = JSON.parse(result);
  } catch {
    return [];
  }
  const parsed = searchPayloadSchema.safeParse(json);
  if (!parsed.success) return [];
  const rows = Array.isArray(parsed.data)
    ? parsed.data
    : 'results' in parsed.data
      ? parsed.data.results
      : parsed.data.citations;
  return rows.map((row) => ({
    url: row.url,
    title: row.title ?? null,
    content: row.content ?? row.text ?? row.snippet ?? null,
    startIndex: null,
    endIndex: null
  }));
}

/**
 * One list of sources from several, each url once.
 *
 * First mention wins, and later ones only fill in what the first left blank.
 * The same page reached through both routes arrives twice - once from the
 * annotation, which knows where in the answer it was used, and once from the
 * result payload, which knows the excerpt - and neither copy is the complete
 * one, so dropping either would lose something the user can see.
 */
export function mergeCitations(...groups: Citation[][]): Citation[] {
  const byUrl = new Map<string, Citation>();
  for (const group of groups) {
    for (const citation of group) {
      const existing = byUrl.get(citation.url);
      if (existing === undefined) {
        byUrl.set(citation.url, citation);
        continue;
      }
      byUrl.set(citation.url, {
        url: existing.url,
        title: existing.title ?? citation.title,
        content: existing.content ?? citation.content,
        startIndex: existing.startIndex ?? citation.startIndex,
        endIndex: existing.endIndex ?? citation.endIndex
      });
    }
  }
  return [...byUrl.values()];
}

/**
 * Records on their way back to OpenRouter, in the shape it sent them.
 *
 * The replay contract, and the reason `args` and `result` are never re-encoded
 * anywhere between here and the wire: OpenRouter reconstructs an advisor's
 * memory of earlier consultations out of exactly these fields, so a record that
 * came back through a parse and a stringify is a different record as far as
 * that reconstruction is concerned.
 *
 * `index` is deliberately not sent. It numbers a record within one response,
 * and a turn's assistant message may carry records gathered over several
 * rounds; renumbering them would be inventing an ordering, and passing the old
 * numbers through would repeat them. The array order says the same thing
 * without either problem.
 */
export function toReasoningDetails(records: ServerToolRecord[]): Array<Record<string, unknown>> {
  return records.map((record) => ({
    type: 'reasoning.server_tool_call',
    tool_name: record.toolName,
    arguments: record.args,
    result: record.result,
    ...(record.callId === null ? {} : { tool_call_id: record.callId })
  }));
}
