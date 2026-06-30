import { create } from 'zustand';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatStreamChunkPayload,
  ChatStreamReasoningPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload,
  ChatToolStatusPayload,
  ChatConversationRenamedPayload,
  ChatConversationTaggedPayload
} from '../../../shared/chat-types';
import type { PermissionOutcome, PermissionRequestPayload } from '../../../shared/chat-permissions';
import type { SkillMenuItem } from '../../../shared/skill-types';
import type { PromptTemplate } from '../../../shared/prompt-types';
import type { PersonaPreset, ChatUploadsConfig, ChatSearchHit } from '../../../shared/chat-types';
import { DEFAULT_CHAT_UPLOADS } from '../../../shared/chat-types';
import type { Artifact } from '../../../shared/chat-artifacts';
import { StreamBuffer } from './stream-buffer';

export type ChatStatus = 'idle' | 'streaming' | 'error';

/** An artifact opened in the side panel, tagged with its source message. */
export type OpenArtifact = Artifact & { messageId: string };

type ChatStoreState = {
  conversations: ChatConversation[];
  activeId: string | null;
  messages: ChatMessage[];
  /** True from when a conversation is selected until its messages resolve — gates the load skeleton. */
  messagesLoading: boolean;
  streamingText: string | null;
  /** Live chain-of-thought for the in-flight turn; null until the model emits reasoning. */
  streamingReasoning: string | null;
  streamId: string | null;
  models: ChatModel[];
  imageModels: ChatModel[];
  /** Set when the chat model list fails to load, so the picker can offer a retry. */
  modelsError: string | null;
  /** Set when the image model list fails to load, so the picker can offer a retry. */
  imageModelsError: string | null;
  keyPresent: boolean;
  status: ChatStatus;
  error: string | null;
  toolStatus: ChatToolStatusPayload | null;
  permissionRequests: PermissionRequestPayload[];
  /** Non-off skills, for the composer's `/` autocomplete. */
  skillMenu: SkillMenuItem[];
  /** Saved prompt templates, for the composer's `/` autocomplete. */
  promptTemplates: PromptTemplate[];
  /** Named system-prompt personas, for the composer's persona selector. */
  personas: PersonaPreset[];
  /** Attachment limits, for composer validation. */
  uploads: ChatUploadsConfig;
  /** Default sidebar sort order. */
  conversationSort: 'recent' | 'alphabetical';
  /** Active full-text search query (empty = not searching). */
  searchQuery: string;
  /** Conversation ids matching the active search, or null when not searching. */
  searchHits: ChatSearchHit[] | null;
  /** Artifact open in the side panel, or null when the panel is closed. */
  activeArtifact: OpenArtifact | null;

  init: () => Promise<void>;
  openArtifact: (artifact: OpenArtifact) => void;
  closeArtifact: () => void;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  setConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  setConversationFolder: (id: string, folder: string | null) => Promise<void>;
  loadSkillMenu: () => Promise<void>;
  loadPromptTemplates: () => Promise<void>;
  decidePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setConversationModel: (id: string, model: string) => Promise<void>;
  setConversationPersona: (id: string, personaId: string | null) => Promise<void>;
  send: (
    text: string,
    model: string,
    attachments?: string[],
    contextPaths?: string[]
  ) => Promise<void>;
  regenerate: (messageId: string, model: string) => Promise<void>;
  /** Re-stream the response to the last user message after a failed turn. */
  retryLastTurn: (model: string) => Promise<void>;
  editMessage: (messageId: string, text: string, model: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  selectVariant: (messageId: string) => Promise<void>;
  forkConversation: (messageId: string) => Promise<void>;
  exportConversation: (id: string) => Promise<void>;
  cancel: () => void;
  loadModels: () => Promise<void>;
  loadImageModels: () => Promise<void>;
  /** Drop the cached model lists + errors (e.g. after the API key is removed). */
  clearModels: () => void;
  refreshKeyPresence: () => Promise<void>;
};

/** Unsubscribers for the stream event listeners. Replaced on each init(). */
let unsubChunk: (() => void) | null = null;
let unsubReasoning: (() => void) | null = null;
let unsubDone: (() => void) | null = null;
let unsubError: (() => void) | null = null;
let unsubTool: (() => void) | null = null;
let unsubPerm: (() => void) | null = null;
let unsubRenamed: (() => void) | null = null;
let unsubTagged: (() => void) | null = null;

export const useChatStore = create<ChatStoreState>((set, get) => {
  // Coalesce SSE tokens into ~50ms flushes so only the in-flight message
  // re-renders (and re-parses markdown) ~20×/s instead of per token.
  const streamBuffer = new StreamBuffer(50, (delta) => {
    set((s) => ({ streamingText: (s.streamingText ?? '') + delta }));
  });
  // Reasoning streams on its own channel and into its own buffer so thinking
  // tokens never interleave with the answer body.
  const reasoningBuffer = new StreamBuffer(50, (delta) => {
    set((s) => ({ streamingReasoning: (s.streamingReasoning ?? '') + delta }));
  });

  // Events for a stream the renderer hasn't adopted yet. The main-process stream
  // can emit — even terminate — before send()/regenerate() resolves and sets our
  // streamId; without buffering, that terminal event is dropped by the streamId
  // guard and the spinner sticks forever (#436). adoptStream() replays them in
  // order once we learn the id.
  const earlyEvents = new Map<string, Array<() => void>>();
  function onStreamEvent(streamId: string, apply: () => void): void {
    if (streamId === get().streamId) {
      apply();
      return;
    }
    const buf = earlyEvents.get(streamId);
    if (buf) buf.push(apply);
    else earlyEvents.set(streamId, [apply]);
  }
  function adoptStream(streamId: string): void {
    const buffered = earlyEvents.get(streamId);
    earlyEvents.clear(); // a freshly adopted stream supersedes any stale buffers
    buffered?.forEach((fn) => fn());
  }
  // streamId whose terminal DONE should replace (not append) the active branch —
  // set by regenerate so the new variant doesn't briefly stack under the old (#432).
  let replaceOnDone: string | null = null;

  function subscribeToStreamEvents(): void {
    unsubChunk?.();
    unsubReasoning?.();
    unsubDone?.();
    unsubError?.();
    unsubTool?.();
    unsubPerm?.();
    unsubRenamed?.();
    unsubTagged?.();
    unsubChunk = window.fleet.chat.onStreamChunk((p: ChatStreamChunkPayload) =>
      onStreamEvent(p.streamId, () => streamBuffer.push(p.delta))
    );
    unsubReasoning = window.fleet.chat.onStreamReasoning((p: ChatStreamReasoningPayload) =>
      onStreamEvent(p.streamId, () => reasoningBuffer.push(p.delta))
    );
    unsubDone = window.fleet.chat.onStreamDone((p: ChatStreamDonePayload) =>
      onStreamEvent(p.streamId, () => {
        streamBuffer.reset();
        reasoningBuffer.reset();
        const activeId = get().activeId;
        // Regenerate replaces the active branch via the reload below; appending
        // here would briefly stack the new answer under the old one (#432).
        const replace = replaceOnDone === p.streamId;
        replaceOnDone = null;
        set((s) => ({
          messages: replace ? s.messages : [...s.messages, p.message],
          streamingText: null,
          streamingReasoning: null,
          streamId: null,
          status: 'idle',
          toolStatus: null,
          permissionRequests: []
        }));
        // Reconcile with the authoritative active thread: regenerate/edit change
        // which branch is active and refresh the variant pagers (the optimistic
        // append above keeps the common send path instant).
        if (activeId) {
          void window.fleet.chat.getMessages(activeId).then((messages) => {
            if (get().activeId === activeId && get().status === 'idle') set({ messages });
          });
        }
      })
    );
    unsubError = window.fleet.chat.onStreamError((p: ChatStreamErrorPayload) =>
      onStreamEvent(p.streamId, () => {
        // Flush (not drop) the buffered tails so a mirrored placeholder includes
        // the last <50ms of answer and reasoning tokens.
        streamBuffer.flush();
        reasoningBuffer.flush();
        replaceOnDone = null;
        // User-initiated cancel: main aborted, persisted whatever streamed, and
        // flagged it. Reconcile to that persisted turn (real DB id) with no error
        // bubble — Stop is not a failure.
        if (p.aborted) {
          streamBuffer.reset();
          reasoningBuffer.reset();
          const activeId = get().activeId;
          set({
            status: 'idle',
            error: null,
            streamingText: null,
            streamingReasoning: null,
            streamId: null,
            toolStatus: null,
            permissionRequests: []
          });
          if (activeId) {
            void window.fleet.chat.getMessages(activeId).then((messages) => {
              if (get().activeId === activeId && get().status === 'idle') set({ messages });
            });
          }
          return;
        }
        const { streamId, streamingText, streamingReasoning, activeId } = get();
        const partial = streamingText?.trim() ? streamingText : null;
        const reasoning = streamingReasoning?.trim() ? streamingReasoning : null;
        set((s) => ({
          status: 'error',
          error: p.message,
          streamingText: null,
          streamingReasoning: null,
          streamId: null,
          toolStatus: null,
          permissionRequests: [],
          // Mirror the partial answer + reasoning into the list synchronously so a
          // turn that errored mid-thinking doesn't flicker out; the DB reload below
          // then swaps in the authoritative message (real id + reasoningMs).
          messages:
            (partial || reasoning) && activeId
              ? [
                  ...s.messages,
                  {
                    id: `local-${streamId}`,
                    conversationId: activeId,
                    role: 'assistant',
                    content: partial ?? '',
                    reasoning: reasoning ?? undefined,
                    parentId: null,
                    createdAt: Date.now()
                  }
                ]
              : s.messages
        }));
        // Main persists whatever streamed before the failure to the DB *before*
        // emitting this error, so reload the authoritative thread to replace the
        // ephemeral placeholder above.
        if (activeId) {
          void window.fleet.chat.getMessages(activeId).then((messages) => {
            if (get().activeId === activeId && get().status === 'error') set({ messages });
          });
        }
      })
    );
    unsubTool = window.fleet.chat.onToolStatus((p: ChatToolStatusPayload) =>
      onStreamEvent(p.streamId, () => set({ toolStatus: p.state === 'done' ? null : p }))
    );
    unsubPerm = window.fleet.chat.onPermissionRequest((p: PermissionRequestPayload) =>
      onStreamEvent(p.streamId, () =>
        set((s) => ({ permissionRequests: [...s.permissionRequests, p] }))
      )
    );
    unsubRenamed = window.fleet.chat.onConversationRenamed((p: ChatConversationRenamedPayload) => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === p.id ? { ...c, title: p.title } : c))
      }));
    });
    unsubTagged = window.fleet.chat.onConversationTagged((p: ChatConversationTaggedPayload) => {
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === p.id ? { ...c, tags: p.tags } : c))
      }));
    });
  }

  return {
    conversations: [],
    activeId: null,
    messages: [],
    messagesLoading: false,
    streamingText: null,
    streamingReasoning: null,
    streamId: null,
    models: [],
    imageModels: [],
    modelsError: null,
    imageModelsError: null,
    keyPresent: false,
    status: 'idle',
    error: null,
    toolStatus: null,
    permissionRequests: [],
    skillMenu: [],
    promptTemplates: [],
    personas: [],
    uploads: DEFAULT_CHAT_UPLOADS,
    conversationSort: 'recent',
    searchQuery: '',
    searchHits: null,
    activeArtifact: null,

    openArtifact: (artifact: OpenArtifact) => set({ activeArtifact: artifact }),
    closeArtifact: () => set({ activeArtifact: null }),

    init: async () => {
      subscribeToStreamEvents();
      const conversations = await window.fleet.chat.listConversations();
      set({ conversations });
      await get().refreshKeyPresence();
      await get().loadSkillMenu();
      await get().loadPromptTemplates();
      // Preserve the user's selection across ChatView remounts (e.g. a tab
      // switch away and back). Only auto-select the most-recent conversation on
      // a genuine first load, when no valid conversation is active yet.
      const current = get().activeId;
      if (current && conversations.some((c) => c.id === current)) return;
      const first = conversations[0]?.id ?? null;
      if (first) await get().selectConversation(first);
    },

    loadSkillMenu: async () => {
      const view = await window.fleet.chat.skillsGet();
      set({ skillMenu: view.skills.filter((s) => s.state !== 'off') });
    },

    loadPromptTemplates: async () => {
      const settings = await window.fleet.chat.getSettings();
      set({
        promptTemplates: settings.prompts,
        personas: settings.personas,
        uploads: settings.uploads,
        conversationSort: settings.conversationSort
      });
    },

    search: async (query) => {
      set({ searchQuery: query });
      if (!query.trim()) {
        set({ searchHits: null });
        return;
      }
      const hits = await window.fleet.chat.search(query);
      if (get().searchQuery === query) set({ searchHits: hits });
    },

    clearSearch: () => set({ searchQuery: '', searchHits: null }),

    setConversationPinned: async (id, pinned) => {
      await window.fleet.chat.setConversationPinned(id, pinned);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, pinned } : c))
      }));
    },

    setConversationFolder: async (id, folder) => {
      await window.fleet.chat.setConversationFolder(id, folder);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, folder } : c))
      }));
    },

    decidePermission: async (requestId, outcome) => {
      set((s) => ({
        permissionRequests: s.permissionRequests.filter((r) => r.requestId !== requestId)
      }));
      await window.fleet.chat.decidePermission(requestId, outcome);
    },

    selectConversation: async (id) => {
      // Switching away from a live stream must stop it — otherwise the model
      // keeps generating (and billing) against a conversation no longer on
      // screen (#430). Main persists the partial to the *old* thread, so it's
      // there on return; we don't reconcile it here (we're nulling streamId).
      const active = get().streamId;
      if (active && id !== get().activeId) void window.fleet.chat.cancel(active);
      streamBuffer.reset();
      reasoningBuffer.reset();
      set({
        activeId: id,
        messages: [],
        // Drive the skeleton instead of flashing an empty pane during the async load.
        messagesLoading: true,
        streamingText: null,
        streamingReasoning: null,
        streamId: null,
        status: 'idle',
        error: null,
        toolStatus: null,
        permissionRequests: [],
        activeArtifact: null
      });
      try {
        const messages = await window.fleet.chat.getMessages(id);
        if (get().activeId !== id) return; // switched mid-load
        set({ messages, messagesLoading: false });
      } catch (err) {
        if (get().activeId !== id) return; // switched mid-load
        // Collapse the skeleton and surface the failure instead of pulsing forever.
        set({
          messagesLoading: false,
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to load conversation'
        });
      }
    },

    newConversation: async () => {
      const conv = await window.fleet.chat.createConversation();
      set((s) => ({ conversations: [conv, ...s.conversations] }));
      await get().selectConversation(conv.id);
    },

    deleteConversation: async (id) => {
      await window.fleet.chat.deleteConversation(id);
      const remaining = get().conversations.filter((c) => c.id !== id);
      set({ conversations: remaining });
      if (get().activeId === id) {
        const next = remaining[0]?.id ?? null;
        if (next) await get().selectConversation(next);
        else set({ activeId: null, messages: [], messagesLoading: false });
      }
    },

    renameConversation: async (id, title) => {
      await window.fleet.chat.renameConversation(id, title);
      // A manual rename locks the title so background auto-naming won't overwrite it.
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, title, titleLocked: true } : c
        )
      }));
    },

    setConversationModel: async (id, model) => {
      await window.fleet.chat.setConversationModel(id, model);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, model } : c))
      }));
    },

    setConversationPersona: async (id, personaId) => {
      await window.fleet.chat.setConversationPersona(id, personaId);
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, personaId } : c))
      }));
    },

    send: async (text, model, attachments, contextPaths) => {
      const activeId = get().activeId;
      if (!activeId) return;
      const m = get().models.find((x) => x.id === model);
      try {
        const res = await window.fleet.chat.send({
          conversationId: activeId,
          text,
          model,
          attachments,
          contextPaths,
          supportsTools: m?.supportsTools ?? false,
          supportsImages: m?.inputImage ?? false
        });
        set((s) => ({
          messages: [...s.messages, res.userMessage],
          streamId: res.streamId,
          streamingText: '',
          streamingReasoning: null,
          status: 'streaming',
          error: null,
          toolStatus: null
        }));
        // Replay any events the main stream emitted before send() resolved (#436).
        adoptStream(res.streamId);
      } catch (err) {
        // Surface the failure as an inline error bubble; rethrow so the composer
        // restores the user's draft (it isn't lost on a failed send).
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'Could not send your message. Try again.'
        });
        throw err;
      }
    },

    regenerate: async (messageId, model) => {
      const activeId = get().activeId;
      if (!activeId || get().status === 'streaming') return;
      const m = get().models.find((x) => x.id === model);
      try {
        const res = await window.fleet.chat.regenerate({
          conversationId: activeId,
          messageId,
          model,
          supportsTools: m?.supportsTools ?? false,
          supportsImages: m?.inputImage ?? false
        });
        // The new variant arrives via the DB reload on DONE; mark this stream so
        // the done handler reloads instead of appending the answer under the old
        // one (which would briefly show duplicate replies — #432).
        replaceOnDone = res.streamId;
        set({
          streamId: res.streamId,
          streamingText: '',
          streamingReasoning: null,
          status: 'streaming',
          error: null
        });
        adoptStream(res.streamId); // replay any pre-resolve stream events (#436)
      } catch (err) {
        // The void call sites can't surface this, so set the store error here.
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'Could not regenerate this reply. Try again.'
        });
      }
    },

    retryLastTurn: async (model) => {
      const lastUser = [...get().messages].reverse().find((m) => m.role === 'user');
      if (lastUser) await get().regenerate(lastUser.id, model);
    },

    editMessage: async (messageId, text, model) => {
      const activeId = get().activeId;
      if (!activeId || get().status === 'streaming') return;
      const m = get().models.find((x) => x.id === model);
      try {
        const res = await window.fleet.chat.editMessage({
          conversationId: activeId,
          messageId,
          text,
          model,
          supportsTools: m?.supportsTools ?? false,
          supportsImages: m?.inputImage ?? false
        });
        // Show the new user branch immediately, then stream the reply.
        const messages = await window.fleet.chat.getMessages(activeId);
        set({
          messages,
          streamId: res.streamId,
          streamingText: '',
          streamingReasoning: null,
          status: 'streaming',
          error: null,
          toolStatus: null
        });
        adoptStream(res.streamId); // replay any pre-resolve stream events (#436)
      } catch (err) {
        set({
          status: 'error',
          error: err instanceof Error ? err.message : 'Could not edit this message. Try again.'
        });
      }
    },

    deleteMessage: async (messageId) => {
      if (get().status === 'streaming') return;
      // The displayed thread is the linear active path, so a turn and its
      // descendants are the clicked message plus everything after it — slice
      // optimistically, then reconcile with the server's re-pointed path.
      const previous = get().messages;
      const idx = previous.findIndex((m) => m.id === messageId);
      if (idx >= 0) set({ messages: previous.slice(0, idx) });
      try {
        const messages = await window.fleet.chat.deleteMessage(messageId);
        set({ messages });
      } catch (err) {
        // Roll back the optimistic slice so the UI doesn't show a wrongly
        // truncated thread when the backend delete fails.
        set({
          messages: previous,
          status: 'error',
          error: err instanceof Error ? err.message : 'Failed to delete message'
        });
      }
    },

    selectVariant: async (messageId) => {
      if (get().status === 'streaming') return;
      const messages = await window.fleet.chat.selectVariant(messageId);
      set({ messages });
    },

    forkConversation: async (messageId) => {
      const branch = await window.fleet.chat.forkConversation(messageId);
      if (!branch) return;
      set((s) => ({ conversations: [branch, ...s.conversations] }));
      await get().selectConversation(branch.id);
    },

    exportConversation: async (id) => {
      const settings = await window.fleet.chat.getSettings();
      const res = await window.fleet.chat.export(id, settings.exportFormat);
      const url = URL.createObjectURL(new Blob([res.content], { type: res.mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    cancel: () => {
      const { streamId } = get();
      if (!streamId) return;
      // Flush (not drop) the buffered tails so the live partial stays complete on
      // screen until reconciliation swaps in the persisted turn.
      streamBuffer.flush();
      reasoningBuffer.flush();
      // Tell main to abort. It persists whatever streamed and emits
      // CHAT_STREAM_ERROR{aborted:true}; we keep streamId set so that terminal
      // event isn't dropped by the guard — it reconciles this turn to its real
      // DB id (no synthetic local- placeholder that delete/regenerate can't use).
      void window.fleet.chat.cancel(streamId);
    },

    loadModels: async () => {
      try {
        const models = await window.fleet.chat.listModels();
        set({ models, modelsError: null });
      } catch (err) {
        // Record the failure so the picker can show "couldn't load — retry"
        // instead of an empty list that reads as "no models", then rethrow so
        // callers (e.g. saveKey) can react.
        set({ modelsError: err instanceof Error ? err.message : 'Failed to load models.' });
        throw err;
      }
    },

    loadImageModels: async () => {
      try {
        const imageModels = await window.fleet.chat.listImageModels();
        set({ imageModels, imageModelsError: null });
      } catch (err) {
        set({
          imageModelsError: err instanceof Error ? err.message : 'Failed to load image models.'
        });
        throw err;
      }
    },

    clearModels: () =>
      set({ models: [], imageModels: [], modelsError: null, imageModelsError: null }),

    refreshKeyPresence: async () => {
      const keyPresent = await window.fleet.chat.hasKey();
      set({ keyPresent });
    }
  };
});
