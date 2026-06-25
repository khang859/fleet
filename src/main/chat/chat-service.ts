import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatModel,
  ChatCompletionMessage,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload
} from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
import type { ChatSecrets } from './chat-secrets';
import type { OpenRouterClient } from './openrouter-client';

export type ChatEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  store: ChatStore;
  client: OpenRouterClient;
  secrets: ChatSecrets;
  getDefaultModel: () => string;
  emit: ChatEmitter;
};

export class ChatService {
  private readonly deps: Deps;
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  send(req: ChatSendRequest): ChatSendResponse {
    const { store, secrets, client, getDefaultModel, emit } = this.deps;
    const userMessage = store.addMessage({
      conversationId: req.conversationId,
      role: 'user',
      content: req.text
    });
    const streamId = randomUUID();
    const controller = new AbortController();
    this.inflight.set(streamId, controller);

    const apiKey = secrets.getKey();
    const model = req.model || getDefaultModel();
    const history: ChatCompletionMessage[] = store
      .getMessages(req.conversationId)
      .map((m) => ({ role: m.role, content: m.content }));

    void (async () => {
      let partial = '';
      try {
        if (!apiKey) throw new Error('No OpenRouter API key configured');
        await client.streamCompletion({
          apiKey,
          model,
          messages: history,
          signal: controller.signal,
          onDelta: (delta) => {
            partial += delta;
            emit(IPC_CHANNELS.CHAT_STREAM_CHUNK, {
              streamId,
              delta
            } satisfies ChatStreamChunkPayload);
          }
        });
        const message = store.addMessage({
          conversationId: req.conversationId,
          role: 'assistant',
          content: partial
        });
        emit(IPC_CHANNELS.CHAT_STREAM_DONE, { streamId, message } satisfies ChatStreamDonePayload);
      } catch (err) {
        // Persist whatever streamed so the conversation isn't lost.
        if (partial) {
          store.addMessage({
            conversationId: req.conversationId,
            role: 'assistant',
            content: partial
          });
        }
        emit(IPC_CHANNELS.CHAT_STREAM_ERROR, {
          streamId,
          message: err instanceof Error ? err.message : String(err),
          partial
        } satisfies ChatStreamErrorPayload);
      } finally {
        this.inflight.delete(streamId);
      }
    })();

    return { streamId, userMessage };
  }

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort();
    this.inflight.delete(streamId);
  }

  async listModels(): Promise<ChatModel[]> {
    const key = this.deps.secrets.getKey();
    if (!key) throw new Error('No OpenRouter API key configured');
    return this.deps.client.listModels(key);
  }
}
