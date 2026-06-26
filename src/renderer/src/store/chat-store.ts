import { create } from 'zustand';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload,
  ChatToolStatusPayload,
  ChatConversationRenamedPayload
} from '../../../shared/chat-types';
import type { PermissionOutcome, PermissionRequestPayload } from '../../../shared/chat-permissions';
import type { SkillMenuItem } from '../../../shared/skill-types';

type ChatStatus = 'idle' | 'streaming' | 'error';

type ChatStoreState = {
  conversations: ChatConversation[];
  activeId: string | null;
  messages: ChatMessage[];
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

  init: () => Promise<void>;
  loadSkillMenu: () => Promise<void>;
  decidePermission: (requestId: string, outcome: PermissionOutcome) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  setConversationModel: (id: string, model: string) => Promise<void>;
  send: (text: string, model: string, attachments?: string[]) => Promise<void>;
  regenerate: (messageId: string, model: string) => Promise<void>;
  editMessage: (messageId: string, text: string, model: string) => Promise<void>;
  selectVariant: (messageId: string) => Promise<void>;
  forkConversation: (messageId: string) => Promise<void>;
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

export const useChatStore = create<ChatStoreState>((set, get) => {
  function subscribeToStreamEvents(): void {
    unsubChunk?.();
    unsubDone?.();
    unsubError?.();
    unsubTool?.();
    unsubPerm?.();
    unsubRenamed?.();
    unsubChunk = window.fleet.chat.onStreamChunk((p: ChatStreamChunkPayload) => {
      if (p.streamId !== get().streamId) return;
      set((s) => ({ streamingText: (s.streamingText ?? '') + p.delta }));
    });
    unsubDone = window.fleet.chat.onStreamDone((p: ChatStreamDonePayload) => {
      if (p.streamId !== get().streamId) return;
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
  }

  return {
    conversations: [],
    activeId: null,
    messages: [],
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

    init: async () => {
      subscribeToStreamEvents();
      const conversations = await window.fleet.chat.listConversations();
      set({ conversations });
      await get().refreshKeyPresence();
      await get().loadSkillMenu();
      const first = conversations[0]?.id ?? null;
      if (first) await get().selectConversation(first);
    },

    loadSkillMenu: async () => {
      const view = await window.fleet.chat.skillsGet();
      set({ skillMenu: view.skills.filter((s) => s.state !== 'off') });
    },

    decidePermission: async (requestId, outcome) => {
      set((s) => ({
        permissionRequests: s.permissionRequests.filter((r) => r.requestId !== requestId)
      }));
      await window.fleet.chat.decidePermission(requestId, outcome);
    },

    selectConversation: async (id) => {
      set({
        activeId: id,
        messages: [],
        streamingText: null,
        streamId: null,
        status: 'idle',
        error: null,
        toolStatus: null,
        permissionRequests: []
      });
      const messages = await window.fleet.chat.getMessages(id);
      if (get().activeId !== id) return; // switched mid-load
      set({ messages });
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
        else set({ activeId: null, messages: [] });
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

    send: async (text, model, attachments) => {
      const activeId = get().activeId;
      if (!activeId) return;
      const supportsTools = get().models.find((m) => m.id === model)?.supportsTools ?? false;
      const res = await window.fleet.chat.send({
        conversationId: activeId,
        text,
        model,
        attachments,
        supportsTools
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
      const supportsTools = get().models.find((m) => m.id === model)?.supportsTools ?? false;
      const res = await window.fleet.chat.regenerate({
        conversationId: activeId,
        messageId,
        model,
        supportsTools
      });
      set({ streamId: res.streamId, streamingText: '', status: 'streaming', error: null });
    },

    editMessage: async (messageId, text, model) => {
      const activeId = get().activeId;
      if (!activeId || get().status === 'streaming') return;
      const supportsTools = get().models.find((m) => m.id === model)?.supportsTools ?? false;
      const res = await window.fleet.chat.editMessage({
        conversationId: activeId,
        messageId,
        text,
        model,
        supportsTools
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

    cancel: () => {
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
