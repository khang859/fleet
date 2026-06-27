import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatModel,
  ChatImageRef,
  ChatMessage,
  ChatMessageUsage,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload,
  ChatToolStatusPayload,
  ChatUsageConfig
} from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
import type { ChatSecrets } from './chat-secrets';
import type { OpenRouterClient } from './openrouter-client';
import type { ChatImageProvider } from './image/types';
import type { ChatImageStorage } from './image/image-storage';
import { GENERATE_IMAGE_TOOL, parseGenerateImageArgs, runGenerateImage } from './chat-tools';
import { resolveTitle } from './chat-namer';
import { resolveTags } from './chat-tagger';
import type {
  ChatConversationRenamedPayload,
  ChatConversationTaggedPayload,
  ChatToolsMode,
  ChatToolsConfig,
  PersonaPreset
} from '../../shared/chat-types';
import type { ChatToolExecutor } from './tools/tool-runner';
import {
  buildFsToolDefs,
  FS_TOOL_NAMES,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_NAME
} from './tools/tool-runner';
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
  /** Background topical tagging; `model` is already resolved (taskModel ?? default). */
  getAutoTag: () => { enabled: boolean; model: string };
  getToolsMode: () => ChatToolsMode;
  getTools: () => ChatToolsConfig;
  getUsage: () => ChatUsageConfig;
  getPersonas: () => { presets: PersonaPreset[]; defaultId: string | null };
  /** True when web search is enabled and a search API key is present. */
  isWebSearchReady: () => boolean;
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

/** Is this multimodal content part an OpenRouter file (PDF) attachment? */
function isFilePart(part: unknown): boolean {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'file';
}

/** Sum per-round usage into a running total for the whole assistant turn. */
function addUsage(
  acc: ChatMessageUsage | null,
  next: ChatMessageUsage | null
): ChatMessageUsage | null {
  if (!next) return acc;
  if (!acc) return { ...next };
  return {
    promptTokens: acc.promptTokens + next.promptTokens,
    completionTokens: acc.completionTokens + next.completionTokens,
    cachedTokens: acc.cachedTokens + next.cachedTokens,
    cost: acc.cost == null && next.cost == null ? null : (acc.cost ?? 0) + (next.cost ?? 0)
  };
}

/**
 * A system message, optionally with a provider prompt-cache breakpoint. The
 * breakpoint caches everything up to and including this block (tool defs +
 * system prompt) on providers that support it (Anthropic/Gemini via OpenRouter);
 * others ignore the annotation.
 */
function systemMessage(content: string, cache: boolean): unknown {
  if (!cache) return { role: 'system', content };
  return {
    role: 'system',
    content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  };
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
      supportsImages: !!req.supportsImages,
      attachmentRefs,
      invocationText: req.text,
      contextBlock: this.buildContextBlock(req.contextPaths),
      naming: isFirstExchange ? { firstUser: req.text } : undefined
    });
    return { streamId, userMessage };
  }

  /**
   * Build an OpenRouter content value for a history message. Plain text unless
   * the message carries attachment images/PDFs and the model accepts them, in
   * which case it becomes a multimodal content-parts array.
   */
  private buildMessageContent(m: ChatMessage, supportsImages: boolean): string | unknown[] {
    const attachments = supportsImages
      ? (m.images ?? []).filter((i) => i.kind === 'attachment')
      : [];
    if (attachments.length === 0) return m.content;
    const parts: unknown[] = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const a of attachments) {
      const dataUrl = this.deps.imageStorage.readAsDataUrl(a.ref, a.mimeType);
      if (a.mimeType === 'application/pdf') {
        parts.push({ type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } });
      } else {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }
    return parts;
  }

  /** The persona prompt for a conversation (its override, else the default); null if none. */
  private resolvePersonaPrompt(conversationId: string): string | null {
    const { presets, defaultId } = this.deps.getPersonas();
    const personaId = this.deps.store.getConversation(conversationId)?.personaId ?? defaultId;
    if (!personaId) return null;
    const preset = presets.find((p) => p.id === personaId);
    return preset?.prompt.trim() ? preset.prompt : null;
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
    supportsImages?: boolean;
  }): { streamId: string } {
    const { store } = this.deps;
    const target = store.getMessage(req.messageId);
    // Re-roll an existing assistant turn (regenerate), OR produce the response
    // to a user turn whose stream failed (scoped retry of a failed turn).
    let assistantParentId: string;
    let invocationText: string;
    if (target?.role === 'assistant' && target.parentId) {
      assistantParentId = target.parentId;
      invocationText = store.getMessage(target.parentId)?.content ?? '';
    } else if (target?.role === 'user') {
      assistantParentId = target.id;
      invocationText = target.content;
    } else {
      throw new Error('Cannot regenerate this message');
    }
    const streamId = this.streamAssistant({
      conversationId: req.conversationId,
      assistantParentId,
      model: req.model || this.deps.getDefaultModel(),
      supportsTools: !!req.supportsTools,
      supportsImages: !!req.supportsImages,
      attachmentRefs: [],
      invocationText
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
    supportsImages?: boolean;
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
      supportsImages: !!req.supportsImages,
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
    supportsImages: boolean;
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
      supportsImages,
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
    const webSearchEnabled = supportsTools && this.deps.isWebSearchReady();
    const toolDefs: unknown[] = [
      ...(imageToolEnabled ? [GENERATE_IMAGE_TOOL] : []),
      ...fsToolDefs,
      ...(webSearchEnabled ? [WEB_SEARCH_TOOL] : []),
      ...mcpToolDefs,
      ...(loadSkillDef ? [loadSkillDef] : [])
    ];

    // Build OpenRouter-shaped history from the active path, prefixed with the
    // skills system prompt (progressive disclosure: names+descriptions only) and,
    // when the user explicitly invoked `/skill`, that skill's full body.
    const cachePrompt = this.deps.getUsage().promptCaching;
    const messages: unknown[] = [];
    // Persona first: the highest-level instruction, part of the cacheable prefix.
    const personaPrompt = this.resolvePersonaPrompt(conversationId);
    if (personaPrompt) messages.push({ role: 'system', content: personaPrompt });
    if (supportsTools) {
      const skillsPrompt = this.deps.skills.systemPrompt();
      // Cache the stable prefix (tool defs + skills system prompt) when enabled.
      if (skillsPrompt) messages.push(systemMessage(skillsPrompt, cachePrompt));
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
    let hasPdf = false;
    for (const m of store.getPathTo(assistantParentId)) {
      const content = this.buildMessageContent(m, supportsImages);
      if (Array.isArray(content) && content.some((p) => isFilePart(p))) hasPdf = true;
      messages.push({ role: m.role, content });
    }
    // OpenRouter's free PDF text-extraction plugin; only needed when a PDF is attached.
    const plugins = hasPdf ? [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }] : undefined;

    void (async () => {
      // Accumulates streamed text across all tool rounds; the final (non-tool) streamCompletion delivers the human-readable reply.
      let partial = '';
      let usage: ChatMessageUsage | null = null;
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
            tools: toolDefs.length ? toolDefs : undefined,
            plugins
          });
          usage = addUsage(usage, result.usage ?? null);

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
            // Native fs/bash, web search, and MCP tools run through the main-process executor (gated).
            if (
              FS_TOOL_NAMES.has(call.name) ||
              isMcpToolName(call.name) ||
              call.name === WEB_SEARCH_TOOL_NAME
            ) {
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
              label: `Generating image with ${imageModel}…`,
              kind: 'image'
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
                error: msg,
                kind: 'image'
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
          parentId: assistantParentId,
          usage
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
        // Background topical tagging always uses the completed first exchange.
        if (params.naming) {
          this.maybeAutoTag(conversationId, params.naming.firstUser, partial);
        }
      } catch (err) {
        if (partial) {
          const m = store.addMessage({
            conversationId,
            role: 'assistant',
            content: partial,
            parentId: assistantParentId,
            usage
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

  /**
   * Fire-and-forget background topical tagging. Never throws and never blocks the
   * stream; no-ops when disabled or keyless. Reuses the task-model path.
   */
  private maybeAutoTag(conversationId: string, firstUser: string, firstAssistant: string): void {
    const { store, client, secrets, emit } = this.deps;
    const cfg = this.deps.getAutoTag();
    if (!cfg.enabled) return;
    const apiKey = secrets.getKey();
    if (!apiKey) return;

    void (async () => {
      const tags = await resolveTags(client, {
        apiKey,
        model: cfg.model,
        firstUser,
        firstAssistant
      });
      if (tags.length === 0) return;
      store.setConversationTags(conversationId, tags);
      emit(IPC_CHANNELS.CHAT_CONVERSATION_TAGGED, {
        id: conversationId,
        tags
      } satisfies ChatConversationTaggedPayload);
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
