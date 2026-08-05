import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  AgentModelConfig,
  AgentSendRequest,
  AgentSettings,
  AgentStreamDelta,
  AgentStreamDone,
  AgentStreamError
} from '../../shared/agent-types';
import { streamCompletion, type AgentWireMessage, type ReasoningParam } from './openrouter';

/**
 * One turn of the agent: take the pane's transcript, stream a reply, emit the
 * deltas. No tools, no persistence - the transcript lives in the renderer and
 * arrives whole with each request, so nothing here survives a restart.
 */

export type AgentEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  getSettings: () => AgentSettings;
  getApiKey: () => string | null;
  emit: AgentEmitter;
  /** Injectable for tests; defaults to the real OpenRouter call. */
  stream?: typeof streamCompletion;
};

function systemPrompt(cwd: string): string {
  return [
    "You are Fleet's coding agent, working in the folder " + cwd + '.',
    'You have no tools yet, so you cannot read or change files.',
    'Answer from what the user tells you, and say plainly when you would need to',
    'see the code rather than guessing at what it contains.'
  ].join('\n');
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

/** Transcript plus the new message, as the wire wants it. */
export function toWireMessages(req: AgentSendRequest): AgentWireMessage[] {
  return [
    { role: 'system', content: systemPrompt(req.cwd) },
    ...req.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: req.text }
  ];
}

export class AgentService {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: Deps) {}

  /** Starts a turn and returns immediately; the reply arrives as stream events. */
  send(req: AgentSendRequest): void {
    void this.run(req.streamId, req);
  }

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort();
  }

  /** Aborts every live turn, e.g. on window teardown. */
  cancelAll(): void {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }

  private async run(streamId: string, req: AgentSendRequest): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(streamId, controller);
    const emit = this.deps.emit;
    try {
      const apiKey = this.deps.getApiKey();
      if (!apiKey) throw new Error('No OpenRouter API key configured');
      const config = this.deps.getSettings().coding;
      if (config.model === null) throw new Error('No coding model selected');

      const stream = this.deps.stream ?? streamCompletion;
      await stream({
        apiKey,
        model: config.model,
        messages: toWireMessages(req),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        reasoning: toReasoningParam(config),
        signal: controller.signal,
        onDelta: (delta) =>
          emit(IPC_CHANNELS.AGENT_STREAM_CHUNK, { streamId, delta } satisfies AgentStreamDelta),
        onReasoning: (delta) =>
          emit(IPC_CHANNELS.AGENT_STREAM_REASONING, { streamId, delta } satisfies AgentStreamDelta)
      });
      emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId } satisfies AgentStreamDone);
    } catch (err) {
      // A cancel is a normal ending, not a failure: the partial reply the user
      // already saw stays, and no error is shown.
      if (controller.signal.aborted) {
        emit(IPC_CHANNELS.AGENT_STREAM_DONE, { streamId } satisfies AgentStreamDone);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        emit(IPC_CHANNELS.AGENT_STREAM_ERROR, { streamId, message } satisfies AgentStreamError);
      }
    } finally {
      this.inflight.delete(streamId);
    }
  }
}
