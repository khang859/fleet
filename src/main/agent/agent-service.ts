import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createLogger } from '../logger';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentAttachment,
  AgentCompactDone,
  AgentCompactRequest,
  AgentHandOff,
  AgentImagePartial,
  AgentImageModel,
  AgentMessage,
  AgentModelConfig,
  AgentPart,
  AgentSendRequest,
  AgentSettings,
  AgentStreamDelta,
  AgentStreamDone,
  AgentStreamError,
  AgentTurnUsage,
  AgentUsage
} from '../../shared/agent-types';
import {
  EMPTY_AGENT_USAGE,
  MAX_TOOL_ROUNDS_CEILING,
  buildSystemPrompt,
  messageAttachments,
  messageText,
  supportedImageConfig
} from '../../shared/agent-types';
import { addRound } from '../../shared/agent-spend';
import { nextStreak, renderTodoBlock, type AgentTodoItem } from '../../shared/agent-todos';
import { attachmentWireParts, imageWireParts } from './attachments';
import { isScratchDir } from './scratch-dir';
import { expandCommand } from './commands/expand';
import { toDataUrl } from './image-kinds';
import {
  buildImageSpec,
  buildTaskSpec,
  toolDefinitionTokens,
  toolSpecsFor,
  type AgentImageGenerator,
  type AgentMcpCaller,
  type AgentTaskDispatcher,
  type AgentToolCall,
  type AgentScheduleCapability,
  type AgentToolContext,
  type AgentUrlFetcher,
  type ToolSpec
} from '../../shared/agent-tools';
import { SCHEDULE_WIRE_PREFIX, renderScheduleBlock } from '../../shared/agent-schedule';
import type { ScheduleStore } from './schedule-store';
import type { SubagentDefinition } from '../../shared/agent-subagents';
import { buildSkillSpec, type SkillDefinition } from '../../shared/agent-skills';
import { loadSkills } from './skills/definitions';
import { buildMemorySpec, type MemoryDefinition } from '../../shared/agent-memory';
import { loadMemory } from './memory/definitions';
import { renderProjectInstructions } from '../../shared/agent-project-instructions';
import { loadProjectInstructions } from './project-instructions';
import { renderTimeBlock } from '../../shared/agent-environment';
import { readEnvironment } from './environment';
import type { McpManager } from './mcp/manager';
import type { AgentServerToolEvent, AgentToolEvent } from '../../shared/agent-types';
import {
  CLEARED_RESULT_TEXT,
  CLEAR_KEEP_RECENT,
  CLEAR_MIN_TOKENS,
  COMPACT_SYSTEM_PROMPT,
  SUMMARY_WIRE_PREFIX,
  estimateTokens,
  isReproducibleTool,
  withClearedResults
} from '../../shared/agent-context';
import {
  streamCompletion,
  type AgentWireMessage,
  type CompletionsTarget,
  type ReasoningParam,
  type StreamOutcome
} from './completions';
import type { ResolvedTarget } from './model-routing';
import {
  isServerToolName,
  serverToolStops,
  toReasoningDetails,
  type Citation,
  type ServerToolRecord,
  type ServerToolSpec,
  type ServerToolStop
} from '../../shared/agent-server-tools';
import { webSearchSpec } from '../../shared/agent-web-search';
import { hostedFetchSpec } from '../../shared/agent-hosted-fetch';
import { advisorSpec } from '../../shared/agent-advisor';
import { fusionSpec } from '../../shared/agent-fusion';
import { splitDeferred, toolSearchSpec } from '../../shared/agent-tool-search';
import { streamResponse } from './responses';
import { isFusionTurn } from './commands/expand';
import { runAgentTool } from './tools/run';
import {
  TaskFailure,
  type LiveSubagent,
  type SubagentManager,
  type TaskOutcome,
  type TaskRun
} from './subagents/manager';
import { generateImage } from './images';
import { capResult, fetchUrl as defaultFetchUrl, type UrlFetch } from './web';
import type { PermissionGate } from './permissions/gate';

const log = createLogger('agent');

/**
 * One turn of the agent: take the pane's transcript, stream a reply, run
 * whatever the model asks to look at, and go back for more until it has an
 * answer. No persistence here - the transcript lives in the renderer and
 * arrives whole with each request, so nothing in this class survives a restart.
 *
 * Compaction runs through the same client but is not streamed: the pane gets
 * the finished summary in one piece, since watching one being written is noise.
 */

export type AgentEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  getSettings: () => AgentSettings;
  /**
   * The OpenRouter key, or `null` when there is none.
   *
   * Only the endpoints that are OpenRouter's alone still ask for this - image
   * generation. A conversation reaches its model through `resolveTarget`, which
   * may not involve OpenRouter at all.
   */
  getApiKey: () => string | null;
  /** Where a call for one model goes. The only place local and cloud differ. */
  resolveTarget: (modelId: string | null) => ResolvedTarget;
  emit: AgentEmitter;
  /** Decides whether a shell command runs. Only `bash` consults it. */
  gate: PermissionGate;
  /** The connected MCP servers, or `null` when the feature is not wired up. */
  mcp?: McpManager | null;
  /** The subagents on disk, and the ones running. */
  subagents: SubagentManager;
  /** Every conversation's reminders. Only a turn's tools ever reach it. */
  schedules: ScheduleStore;
  /** Injectable for tests; defaults to the real OpenRouter call. */
  stream?: typeof streamCompletion;
  /** Swapped in tests. The Responses transport, used only when tools defer. */
  streamResponses?: typeof streamResponse;
  /** Injectable for tests; defaults to the real OpenRouter image call. */
  image?: typeof generateImage;
  /**
   * What the images endpoint says the chosen model takes, from whatever the
   * catalog has already downloaded. Synchronous and allowed to answer `null`:
   * a turn must not wait on a model list to find out what shapes to offer.
   */
  imageCapabilities?: (modelId: string) => AgentImageModel | null;
  /** Injectable for tests; defaults to the real fetch-and-extract pipeline. */
  fetchUrl?: UrlFetch;
};

/** Everything a model call needs, resolved once before the work starts. */
type CallContext = {
  /** Where this turn's model is, and how to be let in. */
  target: CompletionsTarget;
  /**
   * The OpenRouter key, which is a different question from the one above now
   * that a turn can run entirely on this machine. `null` is an ordinary state
   * rather than a failure: it means the tools that are OpenRouter's alone are
   * not on offer this turn, and the conversation carries on without them.
   */
  openRouterKey: string | null;
  /** The id as the endpoint knows it, with any local prefix already stripped. */
  model: string;
  settings: AgentSettings;
  signal: AbortSignal;
};

/**
 * One run of the round loop: a turn, or a subagent, which are the same thing.
 *
 * Assembled by whoever is starting it rather than derived here, because the
 * whole of the difference between a turn and a subagent is in these fields -
 * different messages, a different tool list, and, for a child, no way to reach
 * an MCP server or to start a subagent of its own.
 */
type RoundsRequest = {
  streamId: string;
  threadId: string;
  cwd: string;
  /** The wire, ready to send. Appended to as the rounds go. */
  messages: AgentWireMessage[];
  tools: ToolSpec[];
  /**
   * Tools the model is told about only if it searches for them.
   *
   * Empty everywhere but a turn on OpenRouter with deferral switched on, which
   * is also the only case that reaches the Responses transport. See
   * `agent-tool-search.ts`.
   */
  deferredTools: ToolSpec[];
  /**
   * Tools OpenRouter runs itself, for the rounds of this run only.
   *
   * Empty for a subagent and for every non-turn call. A remote tool is a second
   * meter on every round it is offered in, and the calls that are not a turn -
   * naming a session, folding one up, judging one command - are short, frequent
   * and have nothing to search for.
   */
  serverTools: ServerToolSpec[];
  /** When OpenRouter should wind up its own loop within a round. */
  serverToolStops: ServerToolStop[] | null;
  /** The connected servers, or `null` for a run that may not reach them. */
  mcp: McpManager | null;
  todos: AgentTodoItem[];
  /**
   * Whether this run is a turn picking up after a subagent reported. False for
   * a subagent, which has never replied to anything and cannot be resumed.
   */
  resumed: boolean;
  /**
   * Built per call rather than per run, the way `generateImage` and the MCP
   * caller are: the report has to come back to the row that asked for it, and
   * the row is only known here.
   */
  dispatchTask: (callId: string) => AgentTaskDispatcher | null;
  findSubagent: ((name: string) => SubagentDefinition | null) | null;
  /** Set for both a turn and a subagent: a skill is text, not a capability. */
  findSkill: ((name: string) => SkillDefinition | null) | null;
  /**
   * Set for both, for the same reason `findSkill` is. What a child does not get
   * is either write tool, and `SUBAGENT_TOOL_NAMES` is where that is decided -
   * not here, where handing over `null` would look like the same thing and would
   * only mean the child could not read what the project already knows.
   */
  findMemory: ((name: string) => MemoryDefinition | null) | null;
  /**
   * Setting a reminder for this conversation, and reading what it has set.
   *
   * `null` for a subagent, for the reason `dispatchTask` is: a child's
   * conversation ends when it reports, so a fire aimed at it would have nothing
   * to wake. Built once per run rather than per call, because unlike a report a
   * fire does not come back to the row that asked for it.
   */
  schedule: AgentScheduleCapability | null;
  /**
   * One finished round of this run's own conversation. Set for a subagent,
   * whose transcript main has to keep because it has no pane; `null` for a turn,
   * whose transcript the pane already owns and writes.
   */
  onRound: ((message: AgentMessage) => void) | null;
  /**
   * Whether to keep the token-by-token text off the wire.
   *
   * Set for a subagent. Nothing is watching it type - its card shows what it is
   * doing, from the tool events, and its words are read afterwards out of its
   * log - so streaming them would be a few thousand IPC messages a run that
   * arrive somewhere with no pane to put them.
   */
  quiet: boolean;
};

/** Ceiling for a summary: enough room for the specifics, not for a retelling. */
const COMPACT_MAX_TOKENS = 4096;

/**
 * How many times one turn may call tools and go back to the model.
 *
 * A cap rather than a trust in the model to stop: a loop that reads the same
 * file forever costs money on every lap, and the number that ends it has to be
 * one nothing can talk its way past.
 *
 * What the number should be is the user's, because it is a judgement about
 * their money and their patience rather than about the model. Unset means the
 * ceiling, which exists only to end a loop - so a turn that stops on the
 * setting was stopped on purpose, and one that stops on the ceiling is a bug
 * somewhere. Keeping a plan on the rails is the task list's job, not this
 * number's.
 */
function maxToolRounds(settings: AgentSettings): number {
  const chosen = settings.maxToolRounds;
  return chosen === null ? MAX_TOOL_ROUNDS_CEILING : Math.min(chosen, MAX_TOOL_ROUNDS_CEILING);
}

/**
 * The reasoning parameter this config asks for, in the one form the user set.
 * All unset means no parameter at all, so the model's own default applies.
 */
export function toReasoningParam(config: AgentModelConfig): ReasoningParam | null {
  if (config.reasoningTokens !== null) return { max_tokens: config.reasoningTokens };
  if (config.reasoningEffort !== null) return { effort: config.reasoningEffort };
  if (config.reasoningEnabled !== null) return { enabled: config.reasoningEnabled };
  return null;
}

/**
 * The working folder, as the model should read it.
 *
 * The scratch folder is a real directory and every tool treats it as one, but
 * the prompt line naming it reads exactly like a project's path, and a model
 * told it is working in `~/.fleet/scratch` will go looking for the codebase and
 * the conventions that a path like that implies. Saying what the folder is costs
 * one clause and saves a turn spent hunting for something that was never there.
 *
 * Only the prose changes. Every tool call, every sandbox check and every session
 * header still uses the real, undecorated path.
 */
function promptCwd(cwd: string): string {
  return isScratchDir(cwd)
    ? `${cwd} (Fleet's scratch space, not a project: no repository, no codebase, nothing here is a deliverable)`
    : cwd;
}

/**
 * The way to call a connected server, or `null` when there are none.
 *
 * `null` rather than a function that always refuses, for the reason
 * `generateImage` is null when image generation is off: it is the same answer
 * the model was given when the tools were listed, so the two cannot disagree.
 *
 * The gate is inside it rather than beside it, so there is no way to reach a
 * server's tool that does not pass through the question. A refusal comes back
 * as text the model can read - the same as any other tool saying no - because
 * a turn that ends on a declined call throws away the work it had already done.
 */
function mcpCaller(
  mcp: McpManager | null,
  gate: PermissionGate,
  // Per call rather than per turn, for the reason `imageGenerator` is: the row
  // the question lands on is this call's, and only here is that known.
  at: { streamId: string; callId: string; signal: AbortSignal }
): AgentMcpCaller | null {
  if (mcp === null) return null;
  return async (name, rawArgs) => {
    const server = mcp.serverOf(name);
    const tool = mcp.toolOf(name);
    // No route means no such tool, which the manager says better than a
    // question about a server nobody can name would.
    if (server !== null && tool !== null) {
      const grant = await gate.checkMcp({
        streamId: at.streamId,
        callId: at.callId,
        signal: at.signal,
        wireName: name,
        server,
        tool,
        args: rawArgs,
        readOnly: mcp.isReadOnly(name)
      });
      if (grant === 'refuse') {
        return {
          text: `The user did not allow ${tool} on the ${server} server to run.`,
          isError: true,
          image: null
        };
      }
    }
    return mcp.callTool(name, rawArgs);
  };
}

/** What building the wire needs to know beyond the messages themselves. */
type WireContext = { cwd: string; threadId: string };

/**
 * One round of a run, as the pane would have drawn it.
 *
 * Built here only for a subagent, whose rounds nobody drew: text first and then
 * the calls, which is the order `toWireMessages` reads a message back in, so a
 * child's log replays into the same shape a pane's does.
 */
function roundMessage(
  text: string,
  calls: AgentToolCall[],
  remote: ServerToolRecord[] = [],
  citations: Citation[] = [],
  outputItems: Array<Record<string, unknown>> = []
): AgentMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    reasoning: '',
    reasoningMs: null,
    // Kept beside the records rather than derived from them, so a subagent's
    // transcript holds the sources a native search reported with no record.
    citations,
    parts: [
      // Remote work first, because it happened first: OpenRouter finished its
      // own loop before it sent a byte of the text the model wrote about it.
      ...remote.map((call) => ({ type: 'server_tool' as const, call })),
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      // The round whole, between what it said and what it asked for, which is
      // where `toWireHistory` reads it back from.
      ...(outputItems.length === 0 ? [] : [{ type: 'responses' as const, items: outputItems }]),
      ...calls.map((call) => ({ type: 'tool' as const, call }))
    ]
  };
}

/**
 * Steps of OpenRouter's own loop one request may take.
 *
 * Restated rather than left to their default because it is only sent when a
 * spend stop is, and a `stop_server_tools_when` array replaces `max_tool_calls`
 * outright: an array carrying only a spend condition would have quietly given
 * up the 30-step ceiling as well. Ten rather than thirty because this is one
 * round of one turn, and a turn is many rounds - the number that actually
 * bounds a turn is the spend condition beside it.
 */
const SERVER_TOOL_MAX_STEPS = 10;

/**
 * The remote tools a turn is offered.
 *
 * A function rather than a field so that every call that is not a turn gets an
 * empty list by construction. Naming a session, folding one up and judging a
 * command all go through `call` too, and none of them should be able to run a
 * search - a title that cost a web search is a title nobody would have paid for.
 *
 * The order is fixed and the advisor is first, which is not a style choice. An
 * advisor's memory of its own earlier consultations is keyed on where its entry
 * sits in the request, so an advisor that moves is an advisor that has
 * forgotten - and a list built by appending whatever happens to be switched on
 * moves it every time the user toggles something else. First is the one
 * position nothing else can take.
 */
export function turnServerTools(
  settings: AgentSettings,
  options: { fusion: boolean; toolSearch?: boolean } = { fusion: false }
): ServerToolSpec[] {
  return [
    advisorSpec(settings.advisor),
    webSearchSpec(settings.webSearch),
    hostedFetchSpec(settings.hostedFetch),
    // Only where something is actually deferred. Sent on a request with no
    // deferred tool it is a tool that can only ever answer "nothing found",
    // which costs a round to learn.
    options.toolSearch === true ? toolSearchSpec(settings.toolSearch) : null,
    // Last, and only on the turn that asked for it. A panel is nine model calls
    // on one use, so it is armed by the user typing `/fusion` and by nothing
    // else - there is no setting that can put it on an ordinary turn. Last
    // because the advisor's position must not move, and this entry comes and
    // goes with every review.
    options.fusion ? fusionSpec(settings.fusion) : null
  ].filter((spec): spec is ServerToolSpec => spec !== null);
}

/**
 * The messages for one round, with the task list put back in front of the
 * model.
 *
 * Pushed rather than fetched. A list the model has to ask for is one it asks
 * for once, at the start, and then works for forty rounds from a memory of what
 * it said - which is exactly how a plan comes apart. Handed over unasked on
 * every round, being out of date is not something the model has to notice.
 *
 * It goes last, after the tool results of the round before, so it is the most
 * recent thing said. And it is spliced onto a copy: the reminder describes this
 * round and nothing else, so it must never join the transcript the pane keeps
 * or the array the next round is built from.
 *
 * It rides as a user message rather than a system one for the reason a summary
 * does - a mid-conversation system message is handled inconsistently across
 * providers, and there are several here. Labelling it in the text is enough.
 */
export function withTodoReminder(
  messages: AgentWireMessage[],
  items: AgentTodoItem[],
  streak: number
): AgentWireMessage[] {
  const block = renderTodoBlock(items, streak);
  if (block === null) return messages;
  return [...messages, { role: 'user', content: `${FLEET_WIRE_PREFIX}\n\n${block}` }];
}

/**
 * The messages for one round, with the subagents still out named.
 *
 * The parent is told a child has started and, later, what it said, and that is
 * all: the receipt and the report are the same tool call, minutes apart, with
 * whatever else the turn did in between. Working out who is still out means
 * diffing every receipt in the transcript against every report that has landed
 * since - which a model does correctly for one child and stops doing at three.
 * The list is short, main already holds it, and handing it over costs less than
 * the mistake does.
 *
 * Pushed for the reason the task list is pushed, and omitted for a reason the
 * task list has no equivalent of: for most turns of most conversations nothing
 * is running, and a line saying so every round would be the whole cost of the
 * feature paid on the turns where it has nothing to say.
 *
 * It goes before the task list rather than after, so the plan stays the most
 * recent thing said - the roster is context for the round, the list is what the
 * round is meant to be getting on with.
 */
export function withSubagentReminder(
  messages: AgentWireMessage[],
  running: LiveSubagent[],
  waiting: Set<string>
): AgentWireMessage[] {
  if (running.length === 0) return messages;
  return [
    ...messages,
    { role: 'user', content: `${FLEET_WIRE_PREFIX}\n\n${renderSubagentBlock(running, waiting)}` }
  ];
}

/**
 * The messages for one round, with what this conversation has set to wake it.
 *
 * Pushed for the reason the subagent roster is pushed rather than the reason
 * the task list is: most conversations have nothing scheduled, and a line
 * saying so on every round would be the whole cost of the feature paid on the
 * turns where it has nothing to say.
 *
 * What it buys is the ids. A model that wants to cancel something it set two
 * hours ago would otherwise have to spend a round on `schedule_list` first, and
 * a model that has forgotten it set anything would set it again.
 */
export function withScheduleReminder(
  messages: AgentWireMessage[],
  schedule: AgentScheduleCapability | null
): AgentWireMessage[] {
  if (schedule === null) return messages;
  const block = renderScheduleBlock(schedule.list(), new Date());
  if (block === null) return messages;
  return [...messages, { role: 'user', content: `${FLEET_WIRE_PREFIX}\n\n${block}` }];
}

/**
 * The messages for one round, with the fact that this turn is a continuation.
 *
 * A subagent that reports after its parent has finished resumes the pane, and
 * that resumed turn says nothing of its own - the transcript ends on the report,
 * which is the shape that means "carry on". What it does not say is that the
 * parent already replied. The last thing the *user* said is still the request
 * that started the work, so the standing instruction the model reads is
 * unchanged, and a model reading a review request answers it. Again. At length,
 * nearly word for word, while the user reads the same summary twice.
 *
 * Named rather than inferred: from inside the round loop a resumed turn and a
 * fresh one are the same array of messages, and the difference is only knowable
 * where the turn was started - see `AgentSendRequest.resumed`.
 *
 * Sent on every round of the turn rather than only the first, because it is the
 * last round that writes the answer this is about.
 */
export function withResumeNote(messages: AgentWireMessage[], resumed: boolean): AgentWireMessage[] {
  if (!resumed) return messages;
  return [
    ...messages,
    {
      role: 'user',
      content: `${FLEET_WIRE_PREFIX}\n\n${[
        'A subagent has just reported back. You have already replied in this conversation.',
        'Say what this report adds or changes, and nothing you have said already - the user can read your earlier answer and does not want it a second time.',
        'If it changes nothing worth saying, say only that.'
      ].join('\n')}`
    }
  ];
}

/**
 * How much of the prompt is enough to tell two of them apart.
 *
 * The parent wrote these, so what the line has to do is remind rather than
 * inform - and two `explore` children sent into the same folder are told apart
 * by the middle of the sentence rather than the first few words. Capped anyway,
 * because five of them at whatever length the model felt like writing is a cost
 * that grows with nothing the user asked for.
 */
const SUBAGENT_PROMPT_CHARS = 120;

function renderSubagentBlock(running: LiveSubagent[], waiting: Set<string>): string {
  const lines = running.map((task) => {
    const prompt = task.prompt.trim().replace(/\s+/g, ' ');
    const short =
      prompt.length > SUBAGENT_PROMPT_CHARS
        ? `${prompt.slice(0, SUBAGENT_PROMPT_CHARS).trimEnd()}...`
        : prompt;
    const stopped = waiting.has(task.taskId) ? ' [stopped, waiting for the user to answer it]' : '';
    return `- ${task.agent}${stopped}: ${short}`;
  });

  return [
    'Subagents you started that have not reported back yet:',
    '',
    ...lines,
    '',
    // The same sentence the receipt ended with, because by now the receipt is
    // forty rounds up the context and this is the round where it matters.
    'Each report arrives as the result of the call that started it, and nothing you do will make one arrive sooner.',
    ...(waiting.size > 0
      ? [
          'A stopped one is not working and will not go on until the user answers, so say so rather than waiting on it.'
        ]
      : [])
  ].join('\n');
}

/**
 * The same clearing `toWireHistory` does, for the messages a turn adds to it as
 * it runs.
 *
 * Needed because those two are different things. `toWireHistory` is built once,
 * from the transcript, at the start of a turn; everything after that is
 * appended here round by round and never passes through it again. A turn that
 * runs forty rounds is exactly where clearing earns its keep, and without this
 * none of what it read would be cleared until the *next* turn began.
 *
 * Applied to a copy at the point of sending, like the todo reminder above and
 * for the same reason: the array the next round is built from has to keep the
 * real results, or a second pass would be clearing what it already cleared and
 * counting the saving twice.
 *
 * A picture a `read` handed over rides in a message of its own after the
 * result, and is left alone. Finding it would mean tracking which user message
 * belongs to which call, and an image is a flat 1600 tokens against the
 * thousands a file of source is - so it is not worth the bookkeeping.
 */
type WireToolResult = Extract<AgentWireMessage, { role: 'tool' }>;

export function withClearedWireResults(
  messages: AgentWireMessage[],
  keepRecent = CLEAR_KEEP_RECENT
): AgentWireMessage[] {
  // What each result is an answer to. A `tool` message names only the call's
  // id, so the tool's own name has to come from the assistant message that
  // asked for it.
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  }

  const results = messages.filter((m): m is WireToolResult => m.role === 'tool');
  const older = results.slice(0, Math.max(0, results.length - keepRecent));
  const clearable = older.filter(
    (m) => isReproducibleTool(names.get(m.tool_call_id) ?? '') && m.content !== CLEARED_RESULT_TEXT
  );

  const placeholder = estimateTokens(CLEARED_RESULT_TEXT);
  const freed = clearable.reduce((total, m) => total + estimateTokens(m.content) - placeholder, 0);
  if (freed < CLEAR_MIN_TOKENS) return messages;

  const ids = new Set(clearable.map((m) => m.tool_call_id));
  return messages.map((m) =>
    m.role === 'tool' && ids.has(m.tool_call_id) ? { ...m, content: CLEARED_RESULT_TEXT } : m
  );
}

/**
 * What marks a reminder as Fleet talking rather than the user.
 *
 * Said plainly instead of wrapped in a tag. `<system-reminder>` is a house
 * style of one harness and one provider; here the same turn may be answered by
 * any model OpenRouter routes to, and a tag one of them has never seen is
 * either ignored or read out loud.
 *
 * The same words for every reminder, so a round carrying two of them does not
 * appear to have two different things talking to the model.
 */
export const FLEET_WIRE_PREFIX = 'Note from Fleet, not from the user:';

/**
 * The clock, in the one voice Fleet speaks to the model in.
 *
 * Read here rather than passed in: the time this says is the time the request
 * goes out, and a clock handed down from the caller is a clock that stopped
 * whenever the caller looked at it.
 */
export function wireTime(timeZone: string): string {
  return `${FLEET_WIRE_PREFIX}\n\n${renderTimeBlock(new Date(), timeZone)}`;
}

/**
 * A user message on the wire: what they typed, and whatever rode with it.
 *
 * A message with nothing attached stays a plain string, which is what every
 * turn before this feature was and what every turn without an attachment still
 * is. Only a message that needs parts gets them.
 *
 * A `/command` line becomes the prompt behind it here, which is the one place
 * every user message passes through - the new one and every older one, on every
 * turn. See `expandCommand`.
 */
async function toUserMessage(
  text: string,
  attachments: AgentAttachment[],
  ctx: WireContext
): Promise<AgentWireMessage> {
  const said = await expandCommand(text, ctx.cwd);
  if (attachments.length === 0) return { role: 'user', content: said };
  const parts = said === '' ? [] : [{ type: 'text' as const, text: said }];
  return { role: 'user', content: [...parts, ...(await attachmentWireParts(attachments, ctx))] };
}

/**
 * One transcript message as the wire wants it. A summary goes back as a
 * labelled user message: it is not something the assistant said, and a
 * mid-conversation system message is handled inconsistently across providers.
 *
 * A turn that used tools becomes several wire messages, rebuilt round by round
 * from the parts: what the assistant said before it called anything, the calls,
 * then their results, then whatever it said next. Rebuilding it in order
 * matters - a model handed its own closing sentence as though it had been
 * written before the search it was reacting to is being told a small lie about
 * its own reasoning.
 *
 * The API requires every tool_call to be followed by its result, so a call
 * whose result was never recorded is given one saying so rather than left
 * dangling.
 *
 * Asynchronous because an attachment is a path: the bytes are read here, on the
 * way out, rather than carried around in the transcript.
 */
async function toWireMessages(
  message: AgentMessage,
  ctx: WireContext
): Promise<AgentWireMessage[]> {
  if (message.role === 'summary') {
    return [{ role: 'user', content: `${SUMMARY_WIRE_PREFIX}\n\n${messageText(message)}` }];
  }
  // Same treatment and for the same reason: no provider has a role for "the
  // app woke this conversation up", so it crosses as a user message with a line
  // in front of it saying who is really talking. Without this branch it falls
  // through to the assistant path below and the model is handed its own note as
  // something it said.
  if (message.role === 'scheduled') {
    return [{ role: 'user', content: `${SCHEDULE_WIRE_PREFIX}\n\n${messageText(message)}` }];
  }
  if (message.role === 'user') {
    return [await toUserMessage(messageText(message), messageAttachments(message), ctx)];
  }

  const wire: AgentWireMessage[] = [];
  let text = '';
  let calls: AgentToolCall[] = [];
  /**
   * The remote work of the round being gathered.
   *
   * Held beside `calls` rather than in it because it goes back a different way:
   * a local call is echoed as a `tool_calls` entry answered by a `tool` message,
   * and a server-tool record is echoed as one entry in `reasoning_details` that
   * already contains its own result. Two channels for two kinds of history.
   */
  let remote: ServerToolRecord[] = [];
  /**
   * The round as the Responses API finished it, when it was one.
   *
   * Handed straight back rather than rebuilt from the parts beside it, which is
   * what the transport asks for: the reasoning items carry an
   * `encrypted_content` nothing on this side can regenerate, and a rebuilt copy
   * of it is not a copy. `toResponsesInput` replays this in place of everything
   * else the round would have become; Chat Completions has no use for it and
   * drops it on the way out.
   */
  let output: Array<Record<string, unknown>> = [];

  /** One round: what was said, what it asked for, and what came back. */
  const flush = async (): Promise<void> => {
    if (text === '' && calls.length === 0 && remote.length === 0 && output.length === 0) return;
    wire.push({
      role: 'assistant',
      content: text,
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.args }
            }))
          }
        : {}),
      ...(remote.length > 0 ? { reasoning_details: toReasoningDetails(remote) } : {}),
      ...(output.length > 0 ? { response_output: output } : {})
    });
    const images: AgentWireMessage[] = [];
    for (const call of calls) {
      wire.push({
        role: 'tool',
        tool_call_id: call.id,
        content: call.result ?? call.error ?? 'This call did not finish.'
      });
      images.push(...(await toolImageMessages(call, ctx.cwd)));
    }
    // After the whole round, not after the call that produced them. A model may
    // ask for several things at once, and the API requires every one of those
    // calls to be answered before anything else is said.
    wire.push(...images);
    text = '';
    calls = [];
    remote = [];
    output = [];
  };

  for (const part of message.parts) {
    // Text after a call opens the next round, so the round that just ended goes
    // out before it rather than swallowing it.
    if (part.type === 'text' && calls.length > 0) await flush();
    // So does a second raw round, and this is the only thing that marks the
    // boundary when a model calls tools twice with nothing said in between -
    // which is most of what a working turn looks like. Without it the second
    // round's items overwrite the first's, and since the items are replayed in
    // place of the message they came from, the first round's `function_call`
    // disappears while the `tool` result answering it does not. That is an
    // unmatched result, which the API rejects outright.
    if (part.type === 'responses' && output.length > 0) await flush();
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool') calls.push(part.call);
    else if (part.type === 'server_tool') remote.push(part.call);
    // Assigned rather than appended: a round has exactly one of these, and the
    // flush above is what keeps that true.
    else if (part.type === 'responses') output = part.items;
    // An attachment on an assistant message cannot happen - only the composer
    // makes them - and there is nothing sensible to send if one ever did.
  }
  await flush();

  // An assistant turn that produced nothing at all still has to be something:
  // a gap in the transcript would leave the next user message following the
  // previous one as though this turn never happened.
  return wire.length > 0 ? wire : [{ role: 'assistant', content: '' }];
}

/**
 * The picture a call is handing back, on a message of its own.
 *
 * A tool result carries text and only text - that is the API's rule, not ours -
 * so an image `read` returned cannot ride on it. It follows the round's results
 * instead, as a user message, which is the one role a picture may travel in.
 */
async function toolImageMessages(call: AgentToolCall, cwd: string): Promise<AgentWireMessage[]> {
  if (call.image === null) return [];
  const parts = await imageWireParts(call.image, basename(call.image.path), cwd);
  return [{ role: 'user', content: parts }];
}

/**
 * Transcript plus the new message, as the wire wants it.
 *
 * Old tool results are dropped on the way out rather than out of the
 * transcript: what the pane holds and what the model is sent are allowed to
 * differ, and this is the only place the difference is made. See
 * `withClearedResults`.
 *
 * `timeFragment` is the clock, and it goes in front of the message it is the
 * time of rather than into the system prompt - see `agent-environment.ts` for
 * why. It rides as a user message because that is the only mid-conversation
 * role every provider agrees on, the same conclusion `SUMMARY_WIRE_PREFIX`
 * reached, and it says what it is in its own text for the same reason.
 */
export async function toWireHistory(
  req: AgentSendRequest,
  systemPrompt: string,
  timeFragment: string | null = null
): Promise<AgentWireMessage[]> {
  const ctx: WireContext = { cwd: req.cwd, threadId: req.threadId };
  const history = await Promise.all(
    withClearedResults(req.history).map(async (m) => toWireMessages(m, ctx))
  );
  // A turn with nothing said is the pane picking the conversation back up after
  // a subagent reported - see `resume`. The transcript already ends on that
  // report, which is the shape that means "carry on", and an empty user message
  // pushed after it would be a question the user did not ask. The clock is left
  // off for that same reason, and costs nothing by being: the report it is
  // resuming from landed a moment ago.
  const opening =
    req.text === '' && req.attachments.length === 0
      ? []
      : [...timeMessages(timeFragment), await toUserMessage(req.text, req.attachments, ctx)];
  return [{ role: 'system', content: systemPrompt }, ...history.flat(), ...opening];
}

/** The clock as a message, or nothing when there is no clock to send. */
function timeMessages(timeFragment: string | null): AgentWireMessage[] {
  return timeFragment === null ? [] : [{ role: 'user', content: timeFragment }];
}

/**
 * The summarizing call. What is being folded up is handed over as a transcript
 * rather than pasted into one prompt, so the model reads it the same way it
 * read it the first time.
 */
export async function toCompactMessages(req: AgentCompactRequest): Promise<AgentWireMessage[]> {
  // Only what was said, not what was looked at: the summary is about the
  // conversation, and a page of tool output would crowd out the part of it
  // worth keeping. Attachments go the same way, and for the same reason - what
  // survives compaction is the conversation, not the screenshot it was about.
  const ctx: WireContext = { cwd: req.cwd, threadId: '' };
  const messages = await Promise.all(
    req.messages.map(async (m) => toWireMessages({ ...m, parts: textOnly(m) }, ctx))
  );
  return [
    { role: 'system', content: `${COMPACT_SYSTEM_PROMPT}\n\nWorking folder: ${req.cwd}` },
    ...messages.flat(),
    { role: 'user', content: 'Write the summary now, following the instructions above.' }
  ];
}

function textOnly(message: AgentMessage): AgentPart[] {
  return [{ type: 'text', text: messageText(message) }];
}

/**
 * The account kept while a turn runs.
 *
 * Here rather than in the renderer because this is the only side that sees the
 * rounds. A turn is one model call per round plus whatever the tools spent, and
 * from outside it looks like a single exchange - so a pane adding up what it
 * was told would be adding up one number and calling it the whole bill.
 *
 * Two numbers come out of the same rounds. Everything is summed, except the
 * context figure, which is the last round alone: see `AgentTurnUsage`.
 */
class TurnAccount {
  private billed: AgentUsage = { ...EMPTY_AGENT_USAGE };
  private context: number | null = null;
  private calls = 0;
  private model: string | null = null;
  private provider: string | null = null;

  /** One model call that reported what it cost. */
  round(usage: AgentUsage): void {
    this.billed = addRound(this.billed, usage);
    this.context = usage.totalTokens;
    this.calls += 1;
  }

  /** Who answered, from the round that just finished. */
  served(outcome: StreamOutcome): void {
    if (outcome.model !== null) this.model = outcome.model;
    if (outcome.provider !== null) this.provider = outcome.provider;
  }

  /**
   * Money spent by a tool rather than by a round - an image, priced whole. It
   * has no tokens to add, and it is still part of what the turn cost.
   */
  flat(costUsd: number): void {
    this.billed = { ...this.billed, costUsd: (this.billed.costUsd ?? 0) + costUsd };
    this.calls += 1;
  }

  /**
   * A model call the turn needed but did not make of the coding model - auto
   * mode asking whether a command is safe.
   *
   * Everything is added except the context figure, which is left where the last
   * round put it. That number is what the next prompt will cost to send, and
   * this call's prompt was one command line: letting it win would have the
   * meter report the window emptying out every time the agent ran something.
   */
  side(usage: AgentTurnUsage): void {
    this.billed = addRound(this.billed, usage.billed);
    this.calls += usage.calls;
  }

  /**
   * What to tell the pane, or `null` when no provider on this turn said
   * anything at all - in which case there is nothing to report but a set of
   * zeroes, and zeroes would be recorded as fact.
   */
  report(): AgentTurnUsage | null {
    if (this.calls === 0) return null;
    return {
      billed: this.billed,
      contextTokens: this.context,
      calls: this.calls,
      model: this.model,
      provider: this.provider
    };
  }
}

export class AgentService {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: Deps) {}

  /** Starts a turn and returns immediately; the reply arrives as stream events. */
  send(req: AgentSendRequest): void {
    void this.run(req.streamId, async (ctx, account) => this.turn(req, ctx, account));
  }

  /** Starts a compaction; the summary arrives as a single done event. */
  compact(req: AgentCompactRequest): void {
    void this.run(req.streamId, async (ctx, account) => this.summarize(req, ctx, account));
  }

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort();
  }

  /** Aborts every live turn, e.g. on window teardown. */
  cancelAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  /**
   * Whether any turn is mid-flight - what {@link cancelAll} would cut off.
   *
   * A gate rather than a list: these are keyed by stream id, and only the
   * renderer knows which pane a stream belongs to, so main cannot name them.
   * It does not need to. Every path that starts a turn marks its pane
   * `working` first, so the pane row the renderer builds already says so.
   */
  hasInflight(): boolean {
    return this.inflight.size > 0;
  }

  /**
   * Refuse the questions these streams are stopped on, leaving the streams
   * themselves alone. Only subagents are ever in that position - see
   * `PermissionGate.refusePending`.
   */
  refusePending(streamIds: string[]): void {
    for (const streamId of streamIds) this.deps.gate.refusePending(streamId);
  }

  /**
   * What a turn and a compaction have in common: one abort controller, the key
   * and model checked once, and any failure reported as a stream error rather
   * than thrown out of a fire-and-forget IPC handler.
   *
   * The account is opened here rather than by the work, because the two endings
   * that skip the work's own report - a cancel and a failure - are caught here.
   * A turn stopped after five rounds was billed for five rounds.
   */
  private async run(
    streamId: string,
    work: (ctx: CallContext, account: TurnAccount) => Promise<void>
  ): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(streamId, controller);
    const account = new TurnAccount();
    try {
      const settings = this.deps.getSettings();
      // Resolved before anything is spent, and it answers both questions at
      // once: whether a model is chosen, and whether there is anywhere to send
      // it. A cloud model with no key and a local model whose server has been
      // deleted fail here, each with its own sentence.
      const resolved = this.deps.resolveTarget(settings.coding.model);
      if (!resolved.ok) throw new Error(resolved.message);

      await work(
        {
          target: resolved.target,
          model: resolved.wireModelId,
          openRouterKey: this.deps.getApiKey(),
          settings,
          signal: controller.signal
        },
        account
      );
    } catch (err) {
      // A cancel is a normal ending, not a failure: the partial reply the user
      // already saw stays, and no error is shown.
      if (controller.signal.aborted) {
        this.deps.emit(IPC_CHANNELS.AGENT_STREAM_DONE, {
          streamId,
          usage: account.report()
        } satisfies AgentStreamDone);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.emit(IPC_CHANNELS.AGENT_STREAM_ERROR, {
          streamId,
          message,
          usage: account.report()
        } satisfies AgentStreamError);
      }
    } finally {
      this.inflight.delete(streamId);
      // A question nobody answered does not outlive the turn that asked it.
      this.deps.gate.endTurn(streamId);
    }
  }

  /**
   * One turn: rounds of model call and tool run, until the model answers
   * without asking for anything else.
   *
   * The messages accumulate across rounds so each call sees what the last one
   * asked for and what came back, and `TurnAccount` accumulates alongside them:
   * every round is billed, so every round is counted.
   */
  private async turn(req: AgentSendRequest, ctx: CallContext, account: TurnAccount): Promise<void> {
    // Drawing is OpenRouter's endpoint whatever the conversation is running on,
    // so it needs a key of its own rather than the turn's target. Until local
    // models existed a key was guaranteed by the time a turn started, and this
    // read `imageModel !== null` alone; now a turn can be under way without
    // one, and offering a tool that cannot run is worse than offering none -
    // the model spends a round discovering it.
    const imageModel = ctx.openRouterKey === null ? null : ctx.settings.image.model;
    // Described in the chosen model's own terms, so the shapes it is offered are
    // the shapes that model renders. Unknown until the catalog has been fetched
    // at least once, in which case the spec falls back to what all of them take.
    const imageSpec =
      imageModel === null
        ? null
        : buildImageSpec(this.deps.imageCapabilities?.(imageModel) ?? null);
    // Read once per turn rather than per round: a server that comes or goes
    // mid-turn would otherwise change what the model was offered between the
    // call it made and the answer it gets.
    const mcp = this.deps.mcp ?? null;
    const mcpSpecs = mcp?.getToolSpecs() ?? [];
    // Deferral needs OpenRouter's executor and its Responses endpoint, so a
    // local target keeps every tool stated in full whatever the setting says.
    // There is nothing to fall back to and nothing to warn about: the user is
    // simply on an endpoint where the saving does not exist.
    const deferring = ctx.settings.toolSearch.enabled && ctx.target.serverTools;
    const { loaded: mcpLoaded, deferred } = splitDeferred(mcpSpecs, deferring);
    const subagents = await this.deps.subagents.list(req.cwd);
    const taskSpec = buildTaskSpec(subagents);
    // Read per turn for the reason subagents are: the file is the interface, and
    // a skill someone has just written should be offered on the next turn rather
    // than on the next launch.
    const skills = await loadSkills(req.cwd);
    const skillSpec = buildSkillSpec(skills);
    // Read per turn for the same reason, and with one more of its own: an entry
    // written in the middle of a turn is on the roster of the next one, with no
    // cache to invalidate and nothing to tell.
    const memories = await loadMemory(req.cwd);
    const memorySpec = buildMemorySpec(memories);
    const instructions = await loadProjectInstructions(req.cwd);
    // Read per turn, so a pane pointed at a new folder - or a folder that has
    // since become a repo - is described as it is now rather than as it was.
    const env = await readEnvironment(req.cwd, ctx.model);
    // Read from the message itself rather than from a flag on the request, so
    // it is decided by the same text `expandCommand` expands and the two cannot
    // disagree. A turn that carries the review prompt but not the tool would
    // send the model looking for something it was not given.
    const fusion = isFusionTurn(req.text);
    // Whether the panel can actually be reached. Server tools live in
    // OpenRouter's executor, so a turn on a local endpoint has no way to run
    // one - `toolsBody` drops the entry, correctly and silently. Silently is
    // the problem: the user asked for a review out loud, so the prompt has to
    // say the panel is unavailable rather than leave the model holding an
    // instruction it cannot follow.
    const panel = !fusion ? false : ctx.target.serverTools ? 'available' : 'unavailable';
    const messages = await toWireHistory(
      req,
      buildSystemPrompt(promptCwd(req.cwd), ctx.settings.systemPrompt, {
        webFetch: ctx.settings.webFetch.enabled,
        // Only when it is actually offered. The block tells the model which of
        // the two readers to reach for, and a turn that describes a tool it
        // was not given teaches it to call something that is not there.
        // And only where the request can carry it. `toolsBody` drops server
        // tools for a target that has none, so on a local endpoint this block
        // would describe a tool the model was never given.
        webSearch: ctx.settings.webSearch.enabled && ctx.target.serverTools,
        // Same gate. The block is entirely about the boundary between the two
        // readers, and there is no boundary to describe on a target that only
        // has one of them.
        hostedFetch: ctx.settings.hostedFetch.enabled && ctx.target.serverTools,
        // Same rule, and the same reason: the block says what this advisor is
        // for and that the question must carry its own context, which is not
        // something the tool description on the wire can say.
        advisor: advisorSpec(ctx.settings.advisor) !== null && ctx.target.serverTools,
        // Same rule again: the block explains that the panel sees only the
        // prompt it is handed, and it is present exactly on the turns the panel
        // is.
        fusion: panel === false ? undefined : panel,
        // Only when something is actually being held back. On a turn with no
        // servers connected the block would tell the model to search a list
        // that is empty, which costs a round to find out.
        toolSearch: deferred.length > 0,
        env,
        image: imageModel !== null,
        mcp: mcpSpecs.length > 0,
        task: taskSpec !== null,
        skill: skillSpec !== null,
        // Always, for a turn, the way the todo block is: `memory_write` is
        // offered on every one of them whether or not anything is recorded yet,
        // because the first entry has to be writable into existence.
        memory: true,
        // Always, for a turn: the three tools are offered on every one of them.
        schedule: true,
        projectInstructions:
          instructions === null
            ? null
            : renderProjectInstructions(instructions.filename, instructions.text)
      }),
      wireTime(env.timeZone)
    );

    const tools = toolSpecsFor({
      image: imageSpec,
      webFetch: ctx.settings.webFetch.enabled,
      mcp: mcpLoaded,
      task: taskSpec,
      skill: skillSpec,
      memory: memorySpec
    });
    // What the tool list costs before the conversation says anything, logged
    // once per turn because it is charged once per round: a turn of eight
    // rounds pays this eight times. It is the figure deferral is judged
    // against, and it moves with what the user has connected rather than with
    // anything Fleet ships, so it has to be read from a real machine.
    log.debug('tool definitions', {
      tools: tools.length,
      mcpTools: mcpSpecs.length,
      deferred: deferred.length,
      tokens: toolDefinitionTokens(tools),
      deferredTokens: toolDefinitionTokens(deferred)
    });

    await this.runRounds(
      {
        streamId: req.streamId,
        threadId: req.threadId,
        cwd: req.cwd,
        messages,
        tools,
        deferredTools: deferred,
        serverTools: turnServerTools(ctx.settings, {
          fusion: panel === 'available',
          // On what is actually held back rather than on the setting. With
          // deferral on and no server connected the tool could only ever
          // answer "nothing found", and the model would spend a round asking.
          toolSearch: deferred.length > 0
        }),
        serverToolStops:
          panel === 'available'
            ? // A review turn does not take the search brake. That figure bounds
              // incidental searching, and one panel of eight models will pass it
              // on the single call the user explicitly asked for. The documented
              // behaviour on crossing it is to finish the pending calls and take
              // one more turn, so the usual case survives - but a turn that
              // searched a little before calling the panel would cross it early
              // and answer without ever running the review, having billed for
              // the searches. The step cap still stands.
              ([
                { type: 'step_count_is', step_count: SERVER_TOOL_MAX_STEPS }
              ] satisfies ServerToolStop[])
            : serverToolStops({
                steps: SERVER_TOOL_MAX_STEPS,
                maxSpendUsd: ctx.settings.webSearch.maxSpendUsd
              }),
        mcp,
        todos: req.todos,
        resumed: req.resumed ?? false,
        // The parent is the only one that gets these. A child's context has
        // neither, which is the half of "no nesting" that does not depend on
        // the tool list being right.
        dispatchTask: this.taskDispatcher(req, ctx, subagents),
        findSubagent: (name) => subagents.find((s) => s.name === name) ?? null,
        findSkill: (name) => skills.find((s) => s.name === name) ?? null,
        findMemory: (name) => memories.find((m) => m.name === name) ?? null,
        schedule: this.scheduleCapability(req),
        // The pane draws this run and writes it down. Only a subagent needs
        // main to keep its transcript, and only a subagent is watched by
        // nobody while it runs.
        onRound: null,
        quiet: false
      },
      ctx,
      account
    );

    this.deps.emit(IPC_CHANNELS.AGENT_STREAM_DONE, {
      streamId: req.streamId,
      usage: account.report(),
      // What the project's own file cost this turn, so the meter can say so.
      // It rides here rather than on a channel of its own because the pane
      // already learns that a turn finished, and a second way of learning the
      // same thing is a second way for the two to disagree.
      projectInstructions:
        instructions === null
          ? null
          : { filename: instructions.filename, tokens: instructions.tokens }
    } satisfies AgentStreamDone);
  }

  /**
   * Rounds of model call and tool run, until the model answers without asking
   * for anything else. What it answered with comes back.
   *
   * The messages accumulate across rounds so each call sees what the last one
   * asked for and what came back, and `TurnAccount` accumulates alongside them:
   * every round is billed, so every round is counted.
   *
   * Shared by a turn and by a subagent, because a subagent is a turn: the same
   * loop, the same tools, the same permission gate, on a stream of its own. What
   * differs is only what is handed in - which messages, which tools, and whether
   * it may start subagents of its own.
   */
  private async runRounds(
    run: RoundsRequest,
    ctx: CallContext,
    account: TurnAccount
  ): Promise<string> {
    const { streamId } = run;
    const emit = this.deps.emit;
    const config = ctx.settings.coding;
    const { messages, tools } = run;
    // A holder rather than a local: it is written inside a callback, where
    // narrowing cannot follow it.
    const round = { content: '' };
    // The task list for this run, seeded from what the pane sent and thrown
    // away when it ends. Main keeps no copy between turns: the pane owns the
    // list and writes it to its own log, and a second copy here would only be
    // something to get out of step.
    const todos = { items: run.todos, streak: 0 };
    const rounds = maxToolRounds(ctx.settings);

    for (let attempt = 0; attempt < rounds; attempt++) {
      round.content = '';

      const outcome: StreamOutcome = await this.call(ctx, {
        // A copy, spliced rather than appended. The reminders are about this
        // round only - written into `messages` they would be persisted, resent
        // stale on the next round, and stack up one copy per round of a long
        // turn, each contradicting the last about what the list says. The
        // clearing pass is a copy for the same reason, and runs first so a
        // reminder is never what gets cleared.
        //
        // Both are read fresh here rather than once before the loop: a turn
        // that runs forty rounds is exactly where a child reports back in the
        // middle, and a roster read at the top would go on naming it.
        // Innermost first: the note frames the turn, the roster is context for
        // the round, and the task list goes last so the plan stays the most
        // recent thing said.
        messages: withTodoReminder(
          withScheduleReminder(
            this.withRunningSubagents(
              withResumeNote(withClearedWireResults(messages), run.resumed),
              run.threadId
            ),
            run.schedule
          ),
          todos.items,
          todos.streak
        ),
        maxTokens: config.maxTokens,
        reasoning: toReasoningParam(config),
        tools,
        deferredTools: run.deferredTools,
        serverTools: run.serverTools,
        serverToolStops: run.serverToolStops,
        onDelta: (delta) => {
          round.content += delta;
          if (run.quiet) return;
          emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta } satisfies AgentStreamDelta);
        },
        onReasoning: (delta) => {
          if (run.quiet) return;
          emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta } satisfies AgentStreamDelta);
        },
        onUsage: (usage) => account.round(usage)
      });
      account.served(outcome);

      // Told about before the round is judged finished or not, because it is
      // true either way: OpenRouter ran these whichever way the model then went.
      // A search that led to a final answer would otherwise never be shown.
      //
      // Sources are checked as well as records because a provider that searches
      // natively reports one and not the other: annotations on the reply, no
      // record. Keying the event on records alone loses those sources entirely,
      // and the answer is left citing pages the reader cannot open.
      //
      // The raw round is checked too, and for the same kind of reason: a
      // Responses round with neither records nor sources still has to reach the
      // pane, because the pane is where the transcript lives and the transcript
      // is what the next user turn is answered from.
      const outputItems = outcome.outputItems ?? [];
      if (
        (outcome.serverToolCalls.length > 0 ||
          outcome.citations.length > 0 ||
          outputItems.length > 0) &&
        !run.quiet
      ) {
        emit(IPC_CHANNELS.AGENT_SERVER_TOOL, {
          streamId,
          calls: outcome.serverToolCalls,
          citations: outcome.citations,
          outputItems
        } satisfies AgentServerToolEvent);
      }

      if (outcome.toolCalls.length === 0) {
        run.onRound?.(
          roundMessage(round.content, [], outcome.serverToolCalls, outcome.citations, outputItems)
        );
        return round.content;
      }

      messages.push({
        role: 'assistant',
        content: round.content,
        tool_calls: outcome.toolCalls,
        // Handed straight back on the next round of this same turn. Without
        // this a model that consulted an advisor in round one is answered in
        // round two by an advisor with no memory of having been asked.
        //
        // Two carriers because the two transports keep this in different
        // places, and each is read only by the one that understands it.
        // `reasoning_details` is the channel OpenRouter chose on Chat
        // Completions; `response_output` is the round as the Responses API
        // finished it, which also carries the reasoning `encrypted_content`
        // that has no equivalent in a rebuilt message.
        ...(outcome.serverToolCalls.length === 0
          ? {}
          : { reasoning_details: toReasoningDetails(outcome.serverToolCalls) }),
        ...(outputItems.length === 0 ? {} : { response_output: outputItems })
      });
      const images: AgentWireMessage[] = [];
      const before = todos.items;
      // Finished calls, kept alongside the wire so the round can be written down
      // as the pane would have drawn it. Only a subagent uses this.
      const drawn: AgentToolCall[] = [];
      // Strictly one call after another, which the todo tools rely on: ids are
      // minted against the list as it stands, so two `todo_add` calls running
      // at once would both be told the list is the length it was and hand out
      // the same numbers. Parallelising this loop means giving them a lock.
      for (const call of outcome.toolCalls) {
        // Thrown rather than returned: `run` only tells the renderer a turn is
        // over from its catch, so returning here ends the turn in main while
        // the pane waits on a stream that will never say anything again - and
        // a pane that thinks it is still busy refuses to clear or switch
        // session for as long as it is open.
        if (ctx.signal.aborted) throw new Error('cancelled');
        const done = await this.runTool(streamId, call, {
          cwd: run.cwd,
          threadId: run.threadId,
          signal: ctx.signal,
          // Which pane to open the terminal beside is a question only the
          // renderer can answer, so the turn is what goes over the wire.
          handOff: (command) =>
            emit(IPC_CHANNELS.AGENT_HAND_OFF, { streamId, command } satisfies AgentHandOff),
          // The row is already on screen by the time this is asked, so the
          // question lands on the call it is about.
          approve: async (command) =>
            (await this.deps.gate.check({
              streamId,
              callId: call.id,
              command,
              cwd: run.cwd,
              signal: ctx.signal,
              // Auto mode answers some of these with a model, and a model that
              // was asked was billed. It lands in the turn that caused it
              // rather than anywhere of its own: from the user's side one
              // command ran, and what it took to decide that is part of it.
              onUsage: (usage) => account.side(usage)
            })) === 'run',
          wasRefused: (command) => this.deps.gate.wasRefused(streamId, command),
          // Built per call rather than per turn, because a partial render has
          // to land on the row that asked for it, and only here is that known.
          generateImage: this.imageGenerator(ctx, streamId, call.id),
          fetchUrl: this.urlFetcher(ctx),
          todos: {
            list: () => todos.items,
            save: (items) => {
              todos.items = items;
            }
          },
          mcp: mcpCaller(run.mcp, this.deps.gate, {
            streamId,
            callId: call.id,
            signal: ctx.signal
          }),
          dispatchTask: run.dispatchTask(call.id),
          findSubagent: run.findSubagent,
          findSkill: run.findSkill,
          findMemory: run.findMemory,
          schedule: run.schedule
        });
        drawn.push(done.call);
        // A tool that spent money is part of what the turn cost, and `image` is
        // the one that can: it buys a picture from a second endpoint that
        // prices the whole thing rather than its tokens.
        if (done.costUsd !== null) account.flat(done.costUsd);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: done.call.result ?? `Error: ${done.call.error ?? 'the tool failed'}`
        });
        // The same injection the replayed history gets, and it has to be here
        // too: this loop builds the wire for the rest of *this* turn, so
        // without it a model that asked to look at a screenshot would not see
        // it until the turn after the one it asked in.
        images.push(...(await toolImageMessages(done.call, run.cwd)));
      }
      // Held back until every call in the round has been answered, for the
      // reason `flush` holds them back: the API takes an unbroken run of
      // results, and a picture in the middle of one is not a result.
      messages.push(...images);
      todos.streak = nextStreak(todos.streak, before, todos.items);
      run.onRound?.(
        roundMessage(round.content, drawn, outcome.serverToolCalls, outcome.citations, outputItems)
      );
    }

    throw new Error(
      `Stopped after ${rounds} rounds of tool calls without an answer. Ask again, more narrowly.`
    );
  }

  /**
   * The roster for this round, gathered from the two places that hold it.
   *
   * A method rather than a call at the splice point because it is the only
   * thing there that needs the service's own dependencies: which children this
   * thread is waiting on is the manager's, and which of those are stopped on a
   * question is the gate's. Neither knows about the other, and neither should.
   */
  /**
   * What the schedule tools are given for this turn.
   *
   * The conversation is the schedule's owner, so `threadId` - which is the
   * session id for every turn a pane sends - is what everything here is keyed
   * on, and it is also the ownership check `cancel` makes: one conversation may
   * not cancel another's.
   *
   * The `+ 1` is the whole of the chain guardrail, and it is here rather than in
   * the tool because this is the only place that knows why the turn started. A
   * fire that produced this turn carries its own depth on the request; anything
   * else is depth zero, which is what makes a person asking for a reminder a
   * fresh start every time.
   */
  private scheduleCapability(req: AgentSendRequest): AgentScheduleCapability {
    const chainDepth = req.scheduleChainDepth ?? null;
    return {
      chainDepth,
      create: (input) =>
        this.deps.schedules.create({
          sessionId: req.threadId,
          cwd: req.cwd,
          cron: input.cron,
          note: input.note,
          recurring: input.recurring,
          depth: chainDepth === null ? 0 : chainDepth + 1,
          now: new Date()
        }),
      list: () => this.deps.schedules.list(req.threadId),
      cancel: (id) => this.deps.schedules.cancel(id, req.threadId)
    };
  }

  private withRunningSubagents(messages: AgentWireMessage[], threadId: string): AgentWireMessage[] {
    const running = this.deps.subagents.runningFor(threadId);
    if (running.length === 0) return messages;
    const waiting = new Set(this.deps.gate.waitingOn(running.map((task) => task.taskId)));
    return withSubagentReminder(messages, running, waiting);
  }

  /**
   * The way this turn starts subagents, or `null` when there are none to start.
   *
   * A closure over the turn rather than a method on the manager, because what
   * the manager is missing is all context: which pane to report back to, which
   * folder to work in, and what model `inherit` means today. None of that is a
   * property of a subagent, and all of it is a property of the turn.
   */
  private taskDispatcher(
    req: AgentSendRequest,
    ctx: CallContext,
    definitions: SubagentDefinition[]
  ): (callId: string) => AgentTaskDispatcher | null {
    if (definitions.length === 0) return () => null;
    return (callId) => async (call) =>
      this.deps.subagents.dispatch({
        ...call,
        parentModel: ctx.model,
        threadId: req.threadId,
        callId,
        cwd: req.cwd
      });
  }

  /**
   * One subagent, from its prompt to its report.
   *
   * A turn in every way that matters - the same round loop, the same tools, the
   * same permission gate - with three differences, all of them the point of the
   * feature. It starts from an empty history, so the twenty file reads it does
   * never touch the parent's context. It runs under its own id, which is its
   * stream, its thread, and its session file at once, so cancelling it, billing
   * it and asking permission inside it all work without anything new. And its
   * context has no `dispatchTask` and no MCP, so it cannot start subagents of
   * its own or reach a server on the parent's behalf.
   *
   * What comes back is the last thing it said. Not a summary of the run - the
   * definition asked it for a report, and a report is what a model writes when
   * it stops calling tools.
   */
  async runTask(run: TaskRun): Promise<TaskOutcome> {
    const account = new TurnAccount();
    try {
      const settings = this.deps.getSettings();
      const resolved = this.deps.resolveTarget(run.model);
      if (!resolved.ok) throw new Error(resolved.message);
      const ctx: CallContext = {
        target: resolved.target,
        model: resolved.wireModelId,
        openRouterKey: this.deps.getApiKey(),
        settings,
        signal: run.signal
      };

      // The one thing a child does get that the parent has. A subagent sent to
      // review a change needs the review checklist as much as the parent would,
      // and it has no conversation to have been handed it in.
      const skills = await loadSkills(run.cwd);
      const skillSpec = buildSkillSpec(skills);
      // And the same again for what has been recorded, and for the project's own
      // instructions. A child doing the work needs the house rules and what is
      // already known about the place as much as the parent does, and unlike the
      // parent it has no conversation to have been told them in.
      const memories = await loadMemory(run.cwd);
      const memorySpec = buildMemorySpec(memories);
      const instructions = await loadProjectInstructions(run.cwd);
      // And once more: a child runs `bash` on this machine and has no
      // conversation to have been told which machine that is.
      const env = await readEnvironment(run.cwd, run.model);

      const report = await this.runRounds(
        {
          streamId: run.taskId,
          threadId: run.taskId,
          cwd: run.cwd,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(promptCwd(run.cwd), run.definition.systemPrompt, {
                env,
                // A child is never given the image tool, an MCP server, or a
                // subagent of its own. Skills and memory are the exception -
                // they are text, not a capability.
                image: false,
                // And so is this one: a child sent to find something out needs
                // the same warning about what a fetched page is worth.
                webFetch: ctx.settings.webFetch.enabled && run.tools.includes('web_fetch'),
                skill: skillSpec !== null,
                // Conditional here where it is unconditional for a turn, and
                // that difference is the whole of requirement 7 showing through:
                // a child has no `memory_write`, so with nothing recorded there
                // is nothing to describe.
                memory: memorySpec !== null,
                projectInstructions:
                  instructions === null
                    ? null
                    : renderProjectInstructions(instructions.filename, instructions.text)
              })
            },
            { role: 'user', content: wireTime(env.timeZone) },
            { role: 'user', content: run.prompt }
          ],
          tools: toolSpecsFor({
            image: null,
            // Unlike `image`, this one follows the setting rather than being
            // off for a child: reading a page is how a subagent sent to find
            // something out finds it out, and it costs the parent nothing.
            webFetch: ctx.settings.webFetch.enabled,
            skill: skillSpec,
            memory: memorySpec,
            only: run.tools
          }),
          // A child is not given remote tools, for the reason it is not given
          // the image tool: it is dispatched by the model rather than by a
          // person, so its spending is one step further from anybody who could
          // have decided to allow it. What a child researches on the public web
          // it researches through the parent, which asked it a question.
          // A child is not given an MCP server either, so it has nothing that
          // could be deferred and no search to make.
          deferredTools: [],
          serverTools: [],
          serverToolStops: null,
          mcp: null,
          todos: [],
          // A child answers once and is done. There is nothing for it to be
          // picking back up, and nothing it has already said.
          resumed: false,
          dispatchTask: () => null,
          findSubagent: null,
          findSkill: (name) => skills.find((s) => s.name === name) ?? null,
          findMemory: (name) => memories.find((m) => m.name === name) ?? null,
          // Nothing to schedule against: this conversation ends when the report
          // does, so a fire aimed at it would wake nobody.
          schedule: null,
          onRound: run.onMessage,
          quiet: true
        },
        ctx,
        account
      );
      return { report, usage: account.report() };
    } catch (err) {
      throw new TaskFailure(err instanceof Error ? err.message : String(err), account.report());
    } finally {
      // A question nobody answered does not outlive the subagent that asked it.
      this.deps.gate.endTurn(run.taskId);
    }
  }

  /**
   * The page-reading capability, or `null` when the user has turned it off -
   * which is also when the tool was never offered, so a call that gets this far
   * is one the model invented or replayed out of an older transcript.
   *
   * The settings are closed over rather than handed to the tool, for the reason
   * they are with `generateImage`: whether a local address may be read is the
   * user's decision, and a decision reachable through an argument a model wrote
   * is not a decision.
   */
  private urlFetcher(ctx: CallContext): AgentUrlFetcher | null {
    const config = ctx.settings.webFetch;
    if (!config.enabled) return null;
    const fetchPage = this.deps.fetchUrl ?? defaultFetchUrl;

    return async (url, signal) =>
      capResult(await fetchPage(url, config.allowLocal, signal), config.maxChars);
  }

  /**
   * The image capability for one tool call, or `null` when image generation is
   * off - which is also when the tool was never offered, so a call that gets
   * this far is one the model invented or replayed.
   *
   * The API key stops here: the tool is handed a function, not a credential,
   * and the settings the user chose are closed over rather than passed through
   * arguments a model writes.
   */
  private imageGenerator(
    ctx: CallContext,
    streamId: string,
    callId: string
  ): AgentImageGenerator | null {
    const config = ctx.settings.image;
    const model = config.model;
    // Both, for the reason `turn` gates the spec on both: the endpoint behind
    // this is OpenRouter's, and a turn on a local model may have no key at all.
    if (model === null || ctx.openRouterKey === null) return null;
    const openRouterKey = ctx.openRouterKey;
    const call = this.deps.image ?? generateImage;
    const takes = this.deps.imageCapabilities?.(model) ?? null;

    return async (req, signal) => {
      // A shape the model does not render is refused here rather than by the
      // provider, which would refuse it after the generation was paid for. The
      // sentence is addressed to the model: it gets the round back and can
      // choose again.
      if (
        takes !== null &&
        req.aspectRatio !== null &&
        !takes.aspectRatios.includes(req.aspectRatio)
      ) {
        throw new Error(
          takes.aspectRatios.length === 0
            ? `${model} does not take an aspect ratio - leave it out and describe the shape in the prompt instead.`
            : `${model} does not render ${req.aspectRatio}. It takes: ${takes.aspectRatios.join(', ')}.`
        );
      }

      return call(
        {
          ...req,
          apiKey: openRouterKey,
          model,
          // Narrowed to what this model actually reads. The settings panel only
          // offers supported values, so this catches the leftovers: a config
          // written by hand, or one whose model gained or lost a parameter
          // between the last catalog refresh and now.
          config: takes === null ? config : supportedImageConfig(config, takes),
          onPartial: (image) =>
            this.deps.emit(IPC_CHANNELS.AGENT_IMAGE_PARTIAL, {
              streamId,
              callId,
              image: toDataUrl(image.data, image.mimeType)
            } satisfies AgentImagePartial)
        },
        signal
      );
    };
  }

  /**
   * Run one call and tell the pane about it, before and after.
   *
   * A tool that throws is not a failed turn: what it threw is a sentence the
   * model can read and act on, so it becomes the result of the call and the
   * conversation carries on.
   *
   * What it cost comes back beside the call rather than on it. The call is what
   * the pane draws and what the session log keeps, and a price is neither -
   * it belongs to the turn's account, which is main's to keep.
   */
  private async runTool(
    streamId: string,
    call: { id: string; function: { name: string; arguments: string } },
    tools: AgentToolContext
  ): Promise<{ call: AgentToolCall; costUsd: number | null }> {
    const started: AgentToolCall = {
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
      result: null,
      error: null,
      summary: null,
      image: null,
      todos: null,
      task: null
    };
    this.deps.emit(IPC_CHANNELS.AGENT_TOOL_START, {
      streamId,
      call: started
    } satisfies AgentToolEvent);

    let finished: AgentToolCall;
    let costUsd: number | null = null;
    try {
      // A name in OpenRouter's namespace is work OpenRouter has already done,
      // and nothing here implements it. On Chat Completions these arrive
      // through `reasoning_details` and never reach this loop at all - this is
      // the guard for the day a beta API changes its mind, and it says what
      // happened rather than letting the dispatcher report an unknown tool.
      if (isServerToolName(call.function.name)) {
        throw new Error(
          `${call.function.name} runs on OpenRouter, not here. Its result was already returned to you.`
        );
      }
      const output = await runAgentTool(call.function.name, call.function.arguments, tools);
      finished = {
        ...started,
        result: output.text,
        summary: output.summary,
        image: output.image ?? null,
        todos: output.todos ?? null,
        task: output.task ?? null
      };
      costUsd = output.costUsd ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finished = { ...started, error: message, summary: 'failed' };
    }
    this.deps.emit(IPC_CHANNELS.AGENT_TOOL_END, {
      streamId,
      call: finished
    } satisfies AgentToolEvent);
    return { call: finished, costUsd };
  }

  /*
   * Compacting is a model call like any other, and is billed like one. A total
   * that left it out would drift from the invoice by exactly the amount the
   * user never chose to spend - which is the part they would most want to see.
   */
  private async summarize(
    req: AgentCompactRequest,
    ctx: CallContext,
    account: TurnAccount
  ): Promise<void> {
    const collected = { summary: '' };

    const outcome = await this.call(ctx, {
      messages: await toCompactMessages(req),
      // Never above the summary ceiling, and never above the user's own cap.
      maxTokens: Math.min(COMPACT_MAX_TOKENS, ctx.settings.coding.maxTokens ?? COMPACT_MAX_TOKENS),
      // Summarizing is not what a thinking budget is for, and the reasoning
      // would be thrown away here in any case.
      reasoning: null,
      onDelta: (delta) => {
        collected.summary += delta;
      },
      onReasoning: () => {},
      onUsage: (usage) => account.round(usage)
    });
    account.served(outcome);

    // Replacing the transcript with nothing would erase the conversation, so an
    // empty summary fails the compaction instead.
    if (collected.summary.trim() === '') throw new Error('The model returned an empty summary');

    this.deps.emit(IPC_CHANNELS.AGENT_COMPACT_DONE, {
      streamId: req.streamId,
      summary: collected.summary.trim(),
      usage: account.report()
    } satisfies AgentCompactDone);
  }

  /** The parts of a request both paths share, filled in from settings. */
  private async call(
    ctx: CallContext,
    req: {
      messages: AgentWireMessage[];
      maxTokens: number | null;
      reasoning: ReasoningParam | null;
      tools?: ToolSpec[];
      deferredTools?: ToolSpec[];
      serverTools?: ServerToolSpec[];
      serverToolStops?: ServerToolStop[] | null;
      onDelta: (text: string) => void;
      onReasoning: (text: string) => void;
      onUsage: (usage: AgentUsage) => void;
    }
  ): Promise<StreamOutcome> {
    // The transport follows the request rather than a setting, and this is the
    // one line that chooses it. A deferred tool is only ever populated on a
    // turn against OpenRouter with deferral on, and `openrouter:tool_search` is
    // a 400 on Chat Completions - so the presence of one is exactly the
    // condition that needs the other endpoint. Everything else in the app,
    // including every compaction and every subagent, keeps the transport it
    // has always used.
    const deferring = (req.deferredTools?.length ?? 0) > 0;
    const stream = deferring
      ? (this.deps.streamResponses ?? streamResponse)
      : (this.deps.stream ?? streamCompletion);
    return stream({
      target: ctx.target,
      model: ctx.model,
      temperature: ctx.settings.coding.temperature,
      // On every call rather than only on a turn, because every one of them is
      // billed and every one of them repeats the same system prompt. Naming a
      // session, folding one up and judging a command are short calls, and a
      // short call is exactly where a cached prefix is most of the request.
      // Each is dropped at the wire for a target that is not OpenRouter.
      routing: ctx.settings.routing,
      fallback: ctx.settings.fallback,
      cache: ctx.settings.cache,
      signal: ctx.signal,
      ...req
    });
  }
}
