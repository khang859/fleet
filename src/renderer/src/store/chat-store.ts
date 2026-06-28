import { create } from 'zustand';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatStreamChunkPayload,
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
  streamId: string | null;
  models: ChatModel[];
  imageModels: ChatModel[];
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
  refreshKeyPresence: () => Promise<void>;
};

/** Unsubscribers for the stream event listeners. Replaced on each init(). */
let unsubChunk: (() => void) | null = null;
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

  function subscribeToStreamEvents(): void {
    unsubChunk?.();
    unsubDone?.();
    unsubError?.();
    unsubTool?.();
    unsubPerm?.();
    unsubRenamed?.();
    unsubTagged?.();
    unsubChunk = window.fleet.chat.onStreamChunk((p: ChatStreamChunkPayload) => {
      if (p.streamId !== get().streamId) return;
      streamBuffer.push(p.delta);
    });
    unsubDone = window.fleet.chat.onStreamDone((p: ChatStreamDonePayload) => {
      if (p.streamId !== get().streamId) return;
      streamBuffer.reset();
      const activeId = get().activeId;
      set((s) => ({
        messages: [...s.messages, p.message],
        streamingText: null,
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
    });
    unsubError = window.fleet.chat.onStreamError((p: ChatStreamErrorPayload) => {
      if (p.streamId !== get().streamId) return;
      streamBuffer.reset();
      set({
        status: 'error',
        error: p.message,
        streamingText: null,
        streamId: null,
        toolStatus: null,
        permissionRequests: []
      });
    });
    unsubTool = window.fleet.chat.onToolStatus((p: ChatToolStatusPayload) => {
      if (p.streamId !== get().streamId) return;
      set({ toolStatus: p.state === 'done' ? null : p });
    });
    unsubPerm = window.fleet.chat.onPermissionRequest((p: PermissionRequestPayload) => {
      if (p.streamId !== get().streamId) return;
      set((s) => ({ permissionRequests: [...s.permissionRequests, p] }));
    });
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
    streamId: null,
    models: [],
    imageModels: [],
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
      streamBuffer.reset();
      set({
        activeId: id,
        messages: [],
        // Drive the skeleton instead of flashing an empty pane during the async load.
        messagesLoading: true,
        streamingText: null,
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
        status: 'streaming',
        error: null,
        toolStatus: null
      }));
    },

    regenerate: async (messageId, model) => {
      const activeId = get().activeId;
      if (!activeId || get().status === 'streaming') return;
      const m = get().models.find((x) => x.id === model);
      const res = await window.fleet.chat.regenerate({
        conversationId: activeId,
        messageId,
        model,
        supportsTools: m?.supportsTools ?? false,
        supportsImages: m?.inputImage ?? false
      });
      set({ streamId: res.streamId, streamingText: '', status: 'streaming', error: null });
    },

    retryLastTurn: async (model) => {
      const lastUser = [...get().messages].reverse().find((m) => m.role === 'user');
      if (lastUser) await get().regenerate(lastUser.id, model);
    },

    editMessage: async (messageId, text, model) => {
      const activeId = get().activeId;
      if (!activeId || get().status === 'streaming') return;
      const m = get().models.find((x) => x.id === model);
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
        status: 'streaming',
        error: null,
        toolStatus: null
      });
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
      // Flush (not drop) the buffered tail so the mirrored partial reply below
      // includes the last <50ms of tokens.
      streamBuffer.flush();
      const { streamId, streamingText, activeId } = get();
      if (streamId) void window.fleet.chat.cancel(streamId);
      // Main persists whatever streamed so far; mirror it into the visible
      // list so the partial reply doesn't vanish until the convo is reselected.
      const partial = streamingText?.trim() ? streamingText : null;
      set((s) => ({
        status: 'idle',
        streamId: null,
        streamingText: null,
        toolStatus: null,
        permissionRequests: [],
        messages:
          partial && activeId
            ? [
                ...s.messages,
                {
                  id: `local-${streamId}`,
                  conversationId: activeId,
                  role: 'assistant',
                  content: partial,
                  parentId: null,
                  createdAt: Date.now()
                }
              ]
            : s.messages
      }));
    },

    loadModels: async () => {
      const models = await window.fleet.chat.listModels();
      set({ models });
    },

    loadImageModels: async () => {
      const imageModels = await window.fleet.chat.listImageModels();
      set({ imageModels });
    },

    refreshKeyPresence: async () => {
      const keyPresent = await window.fleet.chat.hasKey();
      set({ keyPresent });
    }
  };
});
