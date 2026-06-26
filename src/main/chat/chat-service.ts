import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatModel,
  ChatImageRef,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload,
  ChatToolStatusPayload
} from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
import type { ChatSecrets } from './chat-secrets';
import type { OpenRouterClient } from './openrouter-client';
import type { ChatImageProvider } from './image/types';
import type { ChatImageStorage } from './image/image-storage';
import { GENERATE_IMAGE_TOOL, parseGenerateImageArgs, runGenerateImage } from './chat-tools';
import { resolveTitle } from './chat-namer';
import type {
  ChatConversationRenamedPayload,
  ChatToolsMode,
  ChatToolsConfig
} from '../../shared/chat-types';
import type { ChatToolExecutor } from './tools/tool-runner';
import { buildFsToolDefs, FS_TOOL_NAMES } from './tools/tool-runner';
import { buildMentionContext, defaultWorkspace } from './tools/fs-tools';
import { isMcpToolName } from '../../shared/mcp-types';
import type { SkillManager } from './skills/skill-manager';

export type ChatEmitter = (channel: string, payload: unknown) => void;

const MAX_TOOL_ROUNDS = 4;

export type NamingConfig = {
  enabled: boolean;
  /** Already resolved (taskModel ?? defaultModel) by the caller. */
  model: string;
  timing: 'after-response' | 'immediate';
};

type Deps = {
  store: ChatStore;
  client: OpenRouterClient;
  secrets: ChatSecrets;
  getDefaultModel: () => string;
  getImageModel: () => string | null;
  getNaming: () => NamingConfig;
  getToolsMode: () => ChatToolsMode;
  getTools: () => ChatToolsConfig;
  getMcpToolDefs: () => unknown[];
  skills: SkillManager;
  toolExecutor: ChatToolExecutor;
  imageProvider: ChatImageProvider;
  imageStorage: ChatImageStorage;
  emit: ChatEmitter;
};

function parseDataUrl(url: string): { data: Buffer; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) return null;
  return { mimeType: m[1], data: Buffer.from(m[2], 'base64') };
}

export class ChatService {
  private readonly deps: Deps;
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  send(req: ChatSendRequest): ChatSendResponse {
    const { store, imageStorage } = this.deps;
    // Capture before we persist the user message: an empty thread means this is
    // the conversation's first exchange, which is what we auto-name from.
    const isFirstExchange = store.getMessages(req.conversationId).length === 0;
    const parentId = store.activeLeafId(req.conversationId);
    const userMessage = store.addMessage({
      conversationId: req.conversationId,
      role: 'user',
      content: req.text,
      parentId
    });

    // Persist attachments (data-URLs) to disk as 'attachment' images on the user message.
    const attachmentRefs: ChatImageRef[] = [];
    for (const dataUrl of req.attachments ?? []) {
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) continue;
      const saved = imageStorage.save(req.conversationId, parsed.data, parsed.mimeType);
      attachmentRefs.push({ ref: saved.ref, mimeType: saved.mimeType, kind: 'attachment' });
    }
    if (attachmentRefs.length) {
      store.addImages({
        messageId: userMessage.id,
        conversationId: req.conversationId,
        images: attachmentRefs
      });
    }

    // "Immediate" auto-naming fires off the first user message alone, before the
    // model responds, so the sidebar updates right away.
    if (isFirstExchange && this.deps.getNaming().timing === 'immediate') {
      this.maybeAutoName(req.conversationId, req.text, '');
    }

    const streamId = this.streamAssistant({
      conversationId: req.conversationId,
      assistantParentId: userMessage.id,
      model: req.model || this.deps.getDefaultModel(),
      supportsTools: !!req.supportsTools,
      attachmentRefs,
      invocationText: req.text,
      contextBlock: this.buildContextBlock(req.contextPaths),
      naming: isFirstExchange ? { firstUser: req.text } : undefined
    });
    return { streamId, userMessage };
  }

  /** Read `@`-mentioned files/folders into a context block (truncated per setting). */
  private buildContextBlock(paths: string[] | undefined): string | undefined {
    if (!paths?.length) return undefined;
    const tools = this.deps.getTools();
    const cwd = defaultWorkspace(tools.workspaceDir);
    const block = buildMentionContext({ paths, cwd, maxBytes: tools.mentionMaxKb * 1024 });
    return block || undefined;
  }

  /** Re-run an assistant turn as a new sibling attempt (preserves the old one). */
  regenerate(req: {
    conversationId: string;
    messageId: string;
    model: string;
    supportsTools?: boolean;
  }): { streamId: string } {
    const { store } = this.deps;
    const target = store.getMessage(req.messageId);
    if (target?.role !== 'assistant' || !target.parentId) {
      throw new Error('Cannot regenerate this message');
    }
    const parentUser = store.getMessage(target.parentId);
    const streamId = this.streamAssistant({
      conversationId: req.conversationId,
      assistantParentId: target.parentId,
      model: req.model || this.deps.getDefaultModel(),
      supportsTools: !!req.supportsTools,
      attachmentRefs: [],
      invocationText: parentUser?.content ?? ''
    });
    return { streamId };
  }

  /** Edit a prior user message as a new sibling turn and re-run from there. */
  editMessage(req: {
    conversationId: string;
    messageId: string;
    text: string;
    model: string;
    supportsTools?: boolean;
  }): ChatSendResponse {
    const { store } = this.deps;
    const target = store.getMessage(req.messageId);
    if (target?.role !== 'user') {
      throw new Error('Can only edit a user message');
    }
    const userMessage = store.addMessage({
      conversationId: req.conversationId,
      role: 'user',
      content: req.text,
      parentId: target.parentId
    });
    const streamId = this.streamAssistant({
      conversationId: req.conversationId,
      assistantParentId: userMessage.id,
      model: req.model || this.deps.getDefaultModel(),
      supportsTools: !!req.supportsTools,
      attachmentRefs: [],
      invocationText: req.text
    });
    return { streamId, userMessage };
  }

  /**
   * Shared streaming core: builds context from the path ending at
   * `assistantParentId`, runs the tool loop, and persists the assistant reply as
   * a child of that parent. Used by send / regenerate / edit.
   */
  private streamAssistant(params: {
    conversationId: string;
    assistantParentId: string;
    model: string;
    supportsTools: boolean;
    attachmentRefs: ChatImageRef[];
    invocationText: string;
    contextBlock?: string;
    naming?: { firstUser: string };
  }): string {
    const { store, secrets, client, getImageModel, imageProvider, imageStorage, emit } = this.deps;
    const {
      conversationId,
      assistantParentId,
      model,
      supportsTools,
      attachmentRefs,
      invocationText
    } = params;

    const streamId = randomUUID();
    const controller = new AbortController();
    this.inflight.set(streamId, controller);

    const apiKey = secrets.getKey();
    const imageModel = getImageModel();
    const imageToolEnabled = !!imageModel && supportsTools;
    // fs/bash tools require a tool-capable model; gated by the tools mode setting.
    const fsToolDefs = supportsTools ? buildFsToolDefs(this.deps.getToolsMode()) : [];
    const mcpToolDefs = supportsTools ? this.deps.getMcpToolDefs() : [];
    const loadSkillDef = supportsTools ? this.deps.skills.toolDef() : null;
    const toolDefs: unknown[] = [
      ...(imageToolEnabled ? [GENERATE_IMAGE_TOOL] : []),
      ...fsToolDefs,
      ...mcpToolDefs,
      ...(loadSkillDef ? [loadSkillDef] : [])
    ];

    // Build OpenRouter-shaped history from the active path, prefixed with the
    // skills system prompt (progressive disclosure: names+descriptions only) and,
    // when the user explicitly invoked `/skill`, that skill's full body.
    const messages: unknown[] = [];
    if (supportsTools) {
      const skillsPrompt = this.deps.skills.systemPrompt();
      if (skillsPrompt) messages.push({ role: 'system', content: skillsPrompt });
      const invoked = this.deps.skills.resolveInvocation(invocationText);
      if (invoked) {
        messages.push({
          role: 'system',
          content: `The user invoked the "${invoked.name}" skill. Follow these instructions:\n\n${invoked.body}`
        });
      }
    }
    // `@`-mentioned file/folder context (ephemeral: not persisted to history).
    if (params.contextBlock) {
      messages.push({ role: 'system', content: params.contextBlock });
    }
    for (const m of store.getPathTo(assistantParentId)) {
      messages.push({ role: m.role, content: m.content });
    }

    void (async () => {
      // Accumulates streamed text across all tool rounds; the final (non-tool) streamCompletion delivers the human-readable reply.
      let partial = '';
      const generated: ChatImageRef[] = [];
      try {
        if (!apiKey) throw new Error('No OpenRouter API key configured');
        for (let r = 0; r < MAX_TOOL_ROUNDS; r++) {
          const result = await client.streamCompletion({
            apiKey,
            model,
            messages,
            signal: controller.signal,
            onDelta: (delta) => {
              partial += delta;
              emit(IPC_CHANNELS.CHAT_STREAM_CHUNK, {
                streamId,
                delta
              } satisfies ChatStreamChunkPayload);
            },
            tools: toolDefs.length ? toolDefs : undefined
          });

          if (result.finishReason !== 'tool_calls' || result.toolCalls.length === 0) break;

          messages.push({
            role: 'assistant',
            content: result.content || null,
            tool_calls: result.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments }
            }))
          });

          for (const call of result.toolCalls) {
            // load_skill is an ungated read of an installed skill body.
            if (this.deps.skills.hasLoadSkillTool(call.name)) {
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: this.deps.skills.runLoadSkill(call.arguments)
              });
              continue;
            }
            // Native fs/bash and MCP tools run through the main-process executor (gated).
            if (FS_TOOL_NAMES.has(call.name) || isMcpToolName(call.name)) {
              const content = await this.deps.toolExecutor.run(call.name, call.arguments, {
                streamId,
                conversationId,
                signal: controller.signal
              });
              messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
              continue;
            }
            if (call.name !== 'generate_image' || !imageModel) {
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: '{"status":"error","error":"unknown tool"}'
              });
              continue;
            }
            emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
              streamId,
              state: 'generating',
              label: `Generating image with ${imageModel}…`
            } satisfies ChatToolStatusPayload);
            try {
              const { prompt, edit } = parseGenerateImageArgs(call.arguments);
              // Reference images must be inlined as base64 data URLs — the
              // remote image API cannot read on-disk paths.
              const refs = edit
                ? this.resolveReferenceImages(conversationId, attachmentRefs)
                : undefined;
              const referenceImages = refs?.map((r) =>
                imageStorage.readAsDataUrl(r.ref, r.mimeType)
              );
              const ref = await runGenerateImage(
                { provider: imageProvider, storage: imageStorage },
                {
                  conversationId,
                  prompt,
                  referenceImages,
                  model: imageModel,
                  signal: controller.signal
                }
              );
              generated.push(ref);
              emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
                streamId,
                state: 'done',
                label: 'Image ready'
              } satisfies ChatToolStatusPayload);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: '{"status":"ok","note":"image generated and shown to the user"}'
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              emit(IPC_CHANNELS.CHAT_TOOL_STATUS, {
                streamId,
                state: 'error',
                label: 'Image generation failed',
                error: msg
              } satisfies ChatToolStatusPayload);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: JSON.stringify({ status: 'error', error: msg })
              });
            }
          }
        }

        // If the model exhausted its tool rounds without producing any closing text
        // and we have no image to show either, surface a fallback so the bubble isn't blank.
        if (partial === '' && generated.length === 0) {
          partial = "I couldn't finish that request — please try again.";
        }

        const message = store.addMessage({
          conversationId,
          role: 'assistant',
          content: partial,
          parentId: assistantParentId
        });
        if (generated.length) {
          store.addImages({
            messageId: message.id,
            conversationId,
            images: generated
          });
        }
        const withImages = generated.length ? { ...message, images: generated } : message;
        emit(IPC_CHANNELS.CHAT_STREAM_DONE, {
          streamId,
          message: withImages
        } satisfies ChatStreamDonePayload);

        // "After response" auto-naming (the default) uses the first exchange.
        if (params.naming && this.deps.getNaming().timing === 'after-response') {
          this.maybeAutoName(conversationId, params.naming.firstUser, partial);
        }
      } catch (err) {
        if (partial) {
          const m = store.addMessage({
            conversationId,
            role: 'assistant',
            content: partial,
            parentId: assistantParentId
          });
          if (generated.length) {
            store.addImages({
              messageId: m.id,
              conversationId,
              images: generated
            });
          }
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

    return streamId;
  }

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort();
    this.inflight.delete(streamId);
  }

  /**
   * Fire-and-forget background auto-naming. Never throws and never blocks the
   * stream; no-ops when disabled, keyless, or the title is already locked.
   */
  private maybeAutoName(conversationId: string, firstUser: string, firstAssistant: string): void {
    const { store, client, secrets, emit } = this.deps;
    const naming = this.deps.getNaming();
    if (!naming.enabled) return;
    const apiKey = secrets.getKey();
    if (!apiKey) return;
    const conv = store.getConversation(conversationId);
    if (!conv || conv.titleLocked) return;

    void (async () => {
      const title = await resolveTitle(client, {
        apiKey,
        model: naming.model,
        firstUser,
        firstAssistant
      });
      const changed = store.autoNameConversation(conversationId, title);
      if (changed) {
        emit(IPC_CHANNELS.CHAT_CONVERSATION_RENAMED, {
          id: conversationId,
          title
        } satisfies ChatConversationRenamedPayload);
      }
    })();
  }

  async listModels(): Promise<ChatModel[]> {
    const key = this.deps.secrets.getKey();
    if (!key) throw new Error('No OpenRouter API key configured');
    return this.deps.client.listModels(key);
  }

  async listImageModels(): Promise<ChatModel[]> {
    const key = this.deps.secrets.getKey();
    if (!key) throw new Error('No OpenRouter API key configured');
    return this.deps.client.listImageModels(key);
  }

  deleteConversationImages(conversationId: string): void {
    this.deps.imageStorage.deleteConversation(conversationId);
  }

  private resolveReferenceImages(
    conversationId: string,
    attachments: ChatImageRef[]
  ): ChatImageRef[] | undefined {
    if (attachments.length) return attachments;
    // most-recent generated image in the conversation
    const msgs = this.deps.store.getMessages(conversationId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const gen = msgs[i].images?.filter((im) => im.kind === 'generated');
      if (gen?.length) return [gen[gen.length - 1]];
    }
    return undefined;
  }
}
