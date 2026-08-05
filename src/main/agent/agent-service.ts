import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentCompactDone,
  AgentCompactRequest,
  AgentHandOff,
  AgentMessage,
  AgentModelConfig,
  AgentSendRequest,
  AgentSettings,
  AgentStreamDelta,
  AgentStreamDone,
  AgentStreamError,
  AgentUsage
} from '../../shared/agent-types';
import { buildSystemPrompt, messageText } from '../../shared/agent-types';
import {
  AGENT_TOOL_SPECS,
  type AgentToolCall,
  type AgentToolContext
} from '../../shared/agent-tools';
import type { AgentToolEvent } from '../../shared/agent-types';
import { COMPACT_SYSTEM_PROMPT, SUMMARY_WIRE_PREFIX } from '../../shared/agent-context';
import {
  streamCompletion,
  type AgentWireMessage,
  type ReasoningParam,
  type StreamOutcome
} from './openrouter';
import { runAgentTool } from './tools/run';
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
  /** Injectable for tests; defaults to the real OpenRouter call. */
  stream?: typeof streamCompletion;
};

/** Everything a model call needs, resolved once before the work starts. */
type CallContext = {
  apiKey: string;
  model: string;
  settings: AgentSettings;
  signal: AbortSignal;
};

/** Ceiling for a summary: enough room for the specifics, not for a retelling. */
const COMPACT_MAX_TOKENS = 4096;

/**
 * How many times one turn may call tools and go back to the model.
 *
 * A cap rather than a trust in the model to stop: a loop that reads the same
 * file forever costs money on every lap, and the number that ends it has to be
 * one nothing can talk its way past. Twelve is well past what an honest
 * question takes and well short of an afternoon.
 */
const MAX_TOOL_ROUNDS = 12;

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
 */
function toWireMessages(message: AgentMessage): AgentWireMessage[] {
  if (message.role === 'summary') {
    return [{ role: 'user', content: `${SUMMARY_WIRE_PREFIX}\n\n${messageText(message)}` }];
  }
  if (message.role === 'user') return [{ role: 'user', content: messageText(message) }];

  const wire: AgentWireMessage[] = [];
  let text = '';
  let calls: AgentToolCall[] = [];

  /** One round: what was said, what it asked for, and what came back. */
  const flush = (): void => {
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
    for (const call of calls) {
      wire.push({
        role: 'tool',
        tool_call_id: call.id,
        content: call.result ?? call.error ?? 'This call did not finish.'
      });
    }
    text = '';
    calls = [];
  };

  for (const part of message.parts) {
    // Text after a call opens the next round, so the round that just ended goes
    // out before it rather than swallowing it.
    if (part.type === 'text' && calls.length > 0) flush();
    if (part.type === 'text') text += part.text;
    else calls.push(part.call);
  }
  flush();

  // An assistant turn that produced nothing at all still has to be something:
  // a gap in the transcript would leave the next user message following the
  // previous one as though this turn never happened.
  return wire.length > 0 ? wire : [{ role: 'assistant', content: '' }];
}

/** Transcript plus the new message, as the wire wants it. */
export function toWireHistory(req: AgentSendRequest, systemPrompt: string): AgentWireMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...req.history.flatMap(toWireMessages),
    { role: 'user', content: req.text }
  ];
}

/**
 * The summarizing call. What is being folded up is handed over as a transcript
 * rather than pasted into one prompt, so the model reads it the same way it
 * read it the first time.
 */
export function toCompactMessages(req: AgentCompactRequest): AgentWireMessage[] {
  return [
    { role: 'system', content: `${COMPACT_SYSTEM_PROMPT}\n\nWorking folder: ${req.cwd}` },
    // Only what was said, not what was looked at: the summary is about the
    // conversation, and a page of tool output would crowd out the part of it
    // worth keeping.
    ...req.messages.flatMap((m) =>
      toWireMessages({ ...m, parts: [{ type: 'text', text: messageText(m) }] })
    ),
    { role: 'user', content: 'Write the summary now, following the instructions above.' }
  ];
}

export class AgentService {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: Deps) {}

  /** Starts a turn and returns immediately; the reply arrives as stream events. */
  send(req: AgentSendRequest): void {
    void this.run(req.streamId, async (ctx) => this.turn(req, ctx));
  }

  /** Starts a compaction; the summary arrives as a single done event. */
  compact(req: AgentCompactRequest): void {
    void this.run(req.streamId, async (ctx) => this.summarize(req, ctx));
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
   * What a turn and a compaction have in common: one abort controller, the key
   * and model checked once, and any failure reported as a stream error rather
   * than thrown out of a fire-and-forget IPC handler.
   */
  private async run(streamId: string, work: (ctx: CallContext) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(streamId, controller);
    try {
      const apiKey = this.deps.getApiKey();
      if (!apiKey) throw new Error('No OpenRouter API key configured');
      const settings = this.deps.getSettings();
      const model = settings.coding.model;
      if (model === null) throw new Error('No coding model selected');

      await work({ apiKey, model, settings, signal: controller.signal });
    } catch (err) {
      // A cancel is a normal ending, not a failure: the partial reply the user
      // already saw stays, and no error is shown.
      if (controller.signal.aborted) {
        this.deps.emit(IPC_CHANNELS.AGENT_STREAM_DONE, {
          streamId,
          usage: null
        } satisfies AgentStreamDone);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.emit(IPC_CHANNELS.AGENT_STREAM_ERROR, {
          streamId,
          message
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
   * asked for and what came back. Usage is taken from the last round, since
   * that is the one whose prompt is the whole conversation.
   */
  private async turn(req: AgentSendRequest, ctx: CallContext): Promise<void> {
    const { streamId } = req;
    const emit = this.deps.emit;
    const config = ctx.settings.coding;
    const messages = toWireHistory(req, buildSystemPrompt(req.cwd, ctx.settings.systemPrompt));
    // Holders rather than locals: they are written inside callbacks, where
    // narrowing cannot follow them.
    const reported: { usage: AgentUsage | null } = { usage: null };
    const round = { content: '' };

    for (let attempt = 0; attempt < MAX_TOOL_ROUNDS; attempt++) {
      round.content = '';

      const outcome: StreamOutcome = await this.call(ctx, {
        messages,
        maxTokens: config.maxTokens,
        reasoning: toReasoningParam(config),
        tools: AGENT_TOOL_SPECS,
        onDelta: (delta) => {
          round.content += delta;
          emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta } satisfies AgentStreamDelta);
        },
        onReasoning: (delta) =>
          emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta } satisfies AgentStreamDelta),
        onUsage: (usage) => {
          reported.usage = usage;
        }
      });

      if (outcome.toolCalls.length === 0) {
        emit(IPC_CHANNELS.AGENT_STREAM_DONE, {
          streamId,
          usage: reported.usage
        } satisfies AgentStreamDone);
        return;
      }

      messages.push({
        role: 'assistant',
        content: round.content,
        tool_calls: outcome.toolCalls
      });
      for (const call of outcome.toolCalls) {
        if (ctx.signal.aborted) return;
        const done = await this.runTool(streamId, call, {
          cwd: req.cwd,
          threadId: req.threadId,
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
              signal: ctx.signal
            })) === 'run',
          wasRefused: (command) => this.deps.gate.wasRefused(streamId, command)
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: done.result ?? `Error: ${done.error ?? 'the tool failed'}`
        });
      }
    }

    throw new Error(
      `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls without an answer. Ask again, more narrowly.`
    );
  }

  /**
   * Run one call and tell the pane about it, before and after.
   *
   * A tool that throws is not a failed turn: what it threw is a sentence the
   * model can read and act on, so it becomes the result of the call and the
   * conversation carries on.
   */
  private async runTool(
    streamId: string,
    call: { id: string; function: { name: string; arguments: string } },
    tools: AgentToolContext
  ): Promise<AgentToolCall> {
    const started: AgentToolCall = {
      id: call.id,
      name: call.function.name,
      args: call.function.arguments,
      result: null,
      error: null,
      summary: null
    };
    this.deps.emit(IPC_CHANNELS.AGENT_TOOL_START, {
      streamId,
      call: started
    } satisfies AgentToolEvent);

    let finished: AgentToolCall;
    try {
      const output = await runAgentTool(call.function.name, call.function.arguments, tools);
      finished = { ...started, result: output.text, summary: output.summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finished = { ...started, error: message, summary: 'failed' };
    }
    this.deps.emit(IPC_CHANNELS.AGENT_TOOL_END, {
      streamId,
      call: finished
    } satisfies AgentToolEvent);
    return finished;
  }

  private async summarize(req: AgentCompactRequest, ctx: CallContext): Promise<void> {
    const collected = { summary: '' };
    const reported: { usage: AgentUsage | null } = { usage: null };

    await this.call(ctx, {
      messages: toCompactMessages(req),
      // Never above the summary ceiling, and never above the user's own cap.
      maxTokens: Math.min(COMPACT_MAX_TOKENS, ctx.settings.coding.maxTokens ?? COMPACT_MAX_TOKENS),
      // Summarizing is not what a thinking budget is for, and the reasoning
      // would be thrown away here in any case.
      reasoning: null,
      onDelta: (delta) => {
        collected.summary += delta;
      },
      onReasoning: () => {},
      onUsage: (usage) => {
        reported.usage = usage;
      }
    });

    // Replacing the transcript with nothing would erase the conversation, so an
    // empty summary fails the compaction instead.
    if (collected.summary.trim() === '') throw new Error('The model returned an empty summary');

    this.deps.emit(IPC_CHANNELS.AGENT_COMPACT_DONE, {
      streamId: req.streamId,
      summary: collected.summary.trim(),
      usage: reported.usage
    } satisfies AgentCompactDone);
  }

  /** The parts of a request both paths share, filled in from settings. */
  private async call(
    ctx: CallContext,
    req: {
      messages: AgentWireMessage[];
      maxTokens: number | null;
      reasoning: ReasoningParam | null;
      tools?: typeof AGENT_TOOL_SPECS;
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
