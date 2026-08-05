import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentCompactDone,
  AgentCompactRequest,
  AgentMessage,
  AgentModelConfig,
  AgentSendRequest,
  AgentSettings,
  AgentStreamDelta,
  AgentStreamDone,
  AgentStreamError,
  AgentUsage
} from '../../shared/agent-types';
import { buildSystemPrompt } from '../../shared/agent-types';
import { COMPACT_SYSTEM_PROMPT, SUMMARY_WIRE_PREFIX } from '../../shared/agent-context';
import { streamCompletion, type AgentWireMessage, type ReasoningParam } from './openrouter';

/**
 * One turn of the agent: take the pane's transcript, stream a reply, emit the
 * deltas. No tools, no persistence - the transcript lives in the renderer and
 * arrives whole with each request, so nothing here survives a restart.
 *
 * Compaction runs through the same client but is not streamed: the pane gets
 * the finished summary in one piece, since watching one being written is noise.
 */

export type AgentEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  getSettings: () => AgentSettings;
  getApiKey: () => string | null;
  emit: AgentEmitter;
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
 */
function toWireMessage(message: AgentMessage): AgentWireMessage {
  if (message.role === 'summary') {
    return { role: 'user', content: `${SUMMARY_WIRE_PREFIX}\n\n${message.content}` };
  }
  return { role: message.role, content: message.content };
}

/** Transcript plus the new message, as the wire wants it. */
export function toWireMessages(req: AgentSendRequest, systemPrompt: string): AgentWireMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...req.history.map(toWireMessage),
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
    ...req.messages.map(toWireMessage),
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
    }
  }

  private async turn(req: AgentSendRequest, ctx: CallContext): Promise<void> {
    const { streamId } = req;
    const emit = this.deps.emit;
    const config = ctx.settings.coding;
    // A holder rather than a local: the assignment happens inside a callback,
    // where narrowing cannot follow it.
    const reported: { usage: AgentUsage | null } = { usage: null };

    await this.call(ctx, {
      messages: toWireMessages(req, buildSystemPrompt(req.cwd, ctx.settings.systemPrompt)),
      maxTokens: config.maxTokens,
      reasoning: toReasoningParam(config),
      onDelta: (delta) =>
        emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta } satisfies AgentStreamDelta),
      onReasoning: (delta) =>
        emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta } satisfies AgentStreamDelta),
      onUsage: (usage) => {
        reported.usage = usage;
      }
    });
    emit(IPC_CHANNELS.AGENT_STREAM_DONE, {
      streamId,
      usage: reported.usage
    } satisfies AgentStreamDone);
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
      onDelta: (text: string) => void;
      onReasoning: (text: string) => void;
      onUsage: (usage: AgentUsage) => void;
    }
  ): Promise<void> {
    const stream = this.deps.stream ?? streamCompletion;
    await stream({
      apiKey: ctx.apiKey,
      model: ctx.model,
      temperature: ctx.settings.coding.temperature,
      signal: ctx.signal,
      ...req
    });
  }
}
