import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentAttachment,
  AgentCompactDone,
  AgentCompactRequest,
  AgentHandOff,
  AgentImagePartial,
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
  messageText
} from '../../shared/agent-types';
import { addRound } from '../../shared/agent-spend';
import { nextStreak, renderTodoBlock, type AgentTodoItem } from '../../shared/agent-todos';
import { attachmentWireParts, imageWireParts } from './attachments';
import { expandCommand } from './commands/expand';
import { toDataUrl } from './image-kinds';
import {
  buildTaskSpec,
  toolSpecsFor,
  type AgentImageGenerator,
  type AgentMcpCaller,
  type AgentTaskDispatcher,
  type AgentToolCall,
  type AgentToolContext,
  type ToolSpec
} from '../../shared/agent-tools';
import type { SubagentDefinition } from '../../shared/agent-subagents';
import type { McpManager } from './mcp/manager';
import type { AgentToolEvent } from '../../shared/agent-types';
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
  type ReasoningParam,
  type StreamOutcome
} from './openrouter';
import { runAgentTool } from './tools/run';
import {
  TaskFailure,
  type SubagentManager,
  type TaskOutcome,
  type TaskRun
} from './subagents/manager';
import { generateImage } from './images';
import type { PermissionGate } from './permissions/gate';

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
  getApiKey: () => string | null;
  emit: AgentEmitter;
  /** Decides whether a shell command runs. Only `bash` consults it. */
  gate: PermissionGate;
  /** The connected MCP servers, or `null` when the feature is not wired up. */
  mcp?: McpManager | null;
  /** The subagents on disk, and the ones running. */
  subagents: SubagentManager;
  /** Injectable for tests; defaults to the real OpenRouter call. */
  stream?: typeof streamCompletion;
  /** Injectable for tests; defaults to the real OpenRouter image call. */
  image?: typeof generateImage;
};

/** Everything a model call needs, resolved once before the work starts. */
type CallContext = {
  apiKey: string;
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
  /** The connected servers, or `null` for a run that may not reach them. */
  mcp: McpManager | null;
  todos: AgentTodoItem[];
  /**
   * Built per call rather than per run, the way `generateImage` and the MCP
   * caller are: the report has to come back to the row that asked for it, and
   * the row is only known here.
   */
  dispatchTask: (callId: string) => AgentTaskDispatcher | null;
  findSubagent: ((name: string) => SubagentDefinition | null) | null;
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
function roundMessage(text: string, calls: AgentToolCall[]): AgentMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    reasoning: '',
    reasoningMs: null,
    parts: [
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
      ...calls.map((call) => ({ type: 'tool' as const, call }))
    ]
  };
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
  return [...messages, { role: 'user', content: `${TODO_WIRE_PREFIX}\n\n${block}` }];
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
 * What marks the reminder as Fleet talking rather than the user.
 *
 * Said plainly instead of wrapped in a tag. `<system-reminder>` is a house
 * style of one harness and one provider; here the same turn may be answered by
 * any model OpenRouter routes to, and a tag one of them has never seen is
 * either ignored or read out loud.
 */
export const TODO_WIRE_PREFIX = 'Note from Fleet, not from the user:';

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
  if (message.role === 'user') {
    return [await toUserMessage(messageText(message), messageAttachments(message), ctx)];
  }

  const wire: AgentWireMessage[] = [];
  let text = '';
  let calls: AgentToolCall[] = [];

  /** One round: what was said, what it asked for, and what came back. */
  const flush = async (): Promise<void> => {
    if (text === '' && calls.length === 0) return;
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
        : {})
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
  };

  for (const part of message.parts) {
    // Text after a call opens the next round, so the round that just ended goes
    // out before it rather than swallowing it.
    if (part.type === 'text' && calls.length > 0) await flush();
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool') calls.push(part.call);
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
 */
export async function toWireHistory(
  req: AgentSendRequest,
  systemPrompt: string
): Promise<AgentWireMessage[]> {
  const ctx: WireContext = { cwd: req.cwd, threadId: req.threadId };
  const history = await Promise.all(
    withClearedResults(req.history).map(async (m) => toWireMessages(m, ctx))
  );
  // A turn with nothing said is the pane picking the conversation back up after
  // a subagent reported - see `resume`. The transcript already ends on that
  // report, which is the shape that means "carry on", and an empty user message
  // pushed after it would be a question the user did not ask.
  const opening =
    req.text === '' && req.attachments.length === 0
      ? []
      : [await toUserMessage(req.text, req.attachments, ctx)];
  return [{ role: 'system', content: systemPrompt }, ...history.flat(), ...opening];
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
      const apiKey = this.deps.getApiKey();
      if (!apiKey) throw new Error('No OpenRouter API key configured');
      const settings = this.deps.getSettings();
      const model = settings.coding.model;
      if (model === null) throw new Error('No coding model selected');

      await work({ apiKey, model, settings, signal: controller.signal }, account);
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
    const imageModel = ctx.settings.image.model;
    // Read once per turn rather than per round: a server that comes or goes
    // mid-turn would otherwise change what the model was offered between the
    // call it made and the answer it gets.
    const mcp = this.deps.mcp ?? null;
    const mcpSpecs = mcp?.getToolSpecs() ?? [];
    const subagents = await this.deps.subagents.list(req.cwd);
    const taskSpec = buildTaskSpec(subagents);
    const messages = await toWireHistory(
      req,
      buildSystemPrompt(req.cwd, ctx.settings.systemPrompt, {
        image: imageModel !== null,
        mcp: mcpSpecs.length > 0,
        task: taskSpec !== null
      })
    );

    await this.runRounds(
      {
        streamId: req.streamId,
        threadId: req.threadId,
        cwd: req.cwd,
        messages,
        tools: toolSpecsFor({ image: imageModel !== null, mcp: mcpSpecs, task: taskSpec }),
        mcp,
        todos: req.todos,
        // The parent is the only one that gets these. A child's context has
        // neither, which is the half of "no nesting" that does not depend on
        // the tool list being right.
        dispatchTask: this.taskDispatcher(req, ctx, subagents),
        findSubagent: (name) => subagents.find((s) => s.name === name) ?? null,
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
      usage: account.report()
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
        // A copy, spliced rather than appended. The reminder is about this
        // round only - written into `messages` it would be persisted, resent
        // stale on the next round, and stack up one copy per round of a long
        // turn, each contradicting the last about what the list says. The
        // clearing pass is a copy for the same reason, and runs first so the
        // reminder is never what gets cleared.
        messages: withTodoReminder(withClearedWireResults(messages), todos.items, todos.streak),
        maxTokens: config.maxTokens,
        reasoning: toReasoningParam(config),
        tools,
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

      if (outcome.toolCalls.length === 0) {
        run.onRound?.(roundMessage(round.content, []));
        return round.content;
      }

      messages.push({
        role: 'assistant',
        content: round.content,
        tool_calls: outcome.toolCalls
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
          findSubagent: run.findSubagent
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
      run.onRound?.(roundMessage(round.content, drawn));
    }

    throw new Error(
      `Stopped after ${rounds} rounds of tool calls without an answer. Ask again, more narrowly.`
    );
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
      const apiKey = this.deps.getApiKey();
      if (!apiKey) throw new Error('No OpenRouter API key configured');
      const settings = this.deps.getSettings();
      const ctx: CallContext = { apiKey, model: run.model, settings, signal: run.signal };

      const report = await this.runRounds(
        {
          streamId: run.taskId,
          threadId: run.taskId,
          cwd: run.cwd,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(run.cwd, run.definition.systemPrompt, {
                // Nothing conditional to say: a child is never given the image
                // tool, an MCP server, or a subagent of its own.
                image: false
              })
            },
            { role: 'user', content: run.prompt }
          ],
          tools: toolSpecsFor({ image: false, only: run.tools }),
          mcp: null,
          todos: [],
          dispatchTask: () => null,
          findSubagent: null,
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
    if (model === null) return null;
    const call = this.deps.image ?? generateImage;

    return async (req, signal) =>
      call(
        {
          ...req,
          apiKey: ctx.apiKey,
          model,
          config,
          onPartial: (image) =>
            this.deps.emit(IPC_CHANNELS.AGENT_IMAGE_PARTIAL, {
              streamId,
              callId,
              image: toDataUrl(image.data, image.mimeType)
            } satisfies AgentImagePartial)
        },
        signal
      );
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
      onDelta: (text: string) => void;
      onReasoning: (text: string) => void;
      onUsage: (usage: AgentUsage) => void;
    }
  ): Promise<StreamOutcome> {
    const stream = this.deps.stream ?? streamCompletion;
    return stream({
      apiKey: ctx.apiKey,
      model: ctx.model,
      temperature: ctx.settings.coding.temperature,
      signal: ctx.signal,
      ...req
    });
  }
}
