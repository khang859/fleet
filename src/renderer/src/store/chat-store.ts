import { create } from 'zustand';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload
} from '../../../shared/chat-types';

type ChatStatus = 'idle' | 'streaming' | 'error';

type ChatStoreState = {
  conversations: ChatConversation[];
  activeId: string | null;
  messages: ChatMessage[];
  streamingText: string | null;
  streamId: string | null;
  models: ChatModel[];
  keyPresent: boolean;
  status: ChatStatus;
  error: string | null;

  init: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  send: (text: string, model: string) => Promise<void>;
  cancel: () => void;
  loadModels: () => Promise<void>;
  refreshKeyPresence: () => Promise<void>;
};

/** Unsubscribers for the three stream event listeners. Replaced on each init(). */
let unsubChunk: (() => void) | null = null;
let unsubDone: (() => void) | null = null;
let unsubError: (() => void) | null = null;

export const useChatStore = create<ChatStoreState>((set, get) => {
  function subscribeToStreamEvents(): void {
    unsubChunk?.();
    unsubDone?.();
    unsubError?.();
    unsubChunk = window.fleet.chat.onStreamChunk((p: ChatStreamChunkPayload) => {
      if (p.streamId !== get().streamId) return;
      set((s) => ({ streamingText: (s.streamingText ?? '') + p.delta }));
    });
    unsubDone = window.fleet.chat.onStreamDone((p: ChatStreamDonePayload) => {
      if (p.streamId !== get().streamId) return;
      set((s) => ({
        messages: [...s.messages, p.message],
        streamingText: null,
        streamId: null,
        status: 'idle'
      }));
    });
    unsubError = window.fleet.chat.onStreamError((p: ChatStreamErrorPayload) => {
      if (p.streamId !== get().streamId) return;
      set({ status: 'error', error: p.message, streamingText: null, streamId: null });
    });
  }

  return {
    conversations: [],
    activeId: null,
    messages: [],
    streamingText: null,
    streamId: null,
    models: [],
    keyPresent: false,
    status: 'idle',
    error: null,

    init: async () => {
      subscribeToStreamEvents();
      const conversations = await window.fleet.chat.listConversations();
      set({ conversations });
      await get().refreshKeyPresence();
      const first = conversations[0]?.id ?? null;
      if (first) await get().selectConversation(first);
    },

    selectConversation: async (id) => {
      set({
        activeId: id,
        messages: [],
        streamingText: null,
        streamId: null,
        status: 'idle',
        error: null
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
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c))
      }));
    },

    send: async (text, model) => {
      subscribeToStreamEvents();
      const activeId = get().activeId;
      if (!activeId) return;
      const res = await window.fleet.chat.send({ conversationId: activeId, text, model });
      set((s) => ({
        messages: [...s.messages, res.userMessage],
        streamId: res.streamId,
        streamingText: '',
        status: 'streaming',
        error: null
      }));
    },

    cancel: () => {
      const id = get().streamId;
      if (id) void window.fleet.chat.cancel(id);
      set({ status: 'idle', streamId: null });
    },

    loadModels: async () => {
      const models = await window.fleet.chat.listModels();
      set({ models });
    },

    refreshKeyPresence: async () => {
      const keyPresent = await window.fleet.chat.hasKey();
      set({ keyPresent });
    }
  };
});
