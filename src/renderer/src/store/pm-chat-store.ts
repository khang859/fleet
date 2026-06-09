import { create } from 'zustand';
import type { TranscriptMessage } from '../../../shared/sessions';

type PmStatus = 'idle' | 'thinking' | 'error';

type PmChatStoreState = {
  panelOpen: boolean;
  /** Board whose conversation is currently loaded (the active board). */
  boardId: string | null;
  status: PmStatus;
  error: string | null;
  messages: TranscriptMessage[];
  togglePanel: () => void;
  closePanel: () => void;
  loadState: (boardId: string) => Promise<void>;
  send: (boardId: string, text: string) => Promise<void>;
  reset: (boardId: string) => Promise<void>;
  applyStatus: (status: PmStatus, error?: string) => void;
  applyTranscript: (messages: TranscriptMessage[]) => void;
};

export const usePmChatStore = create<PmChatStoreState>((set, get) => ({
  panelOpen: false,
  boardId: null,
  status: 'idle',
  error: null,
  messages: [],

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  closePanel: () => set({ panelOpen: false }),

  loadState: async (boardId) => {
    // Clear immediately so a board switch never flashes the previous board's chat.
    set({ boardId, messages: [], status: 'idle', error: null });
    const state = await window.fleet.kanban.pmState(boardId);
    if (get().boardId !== boardId) return; // user switched boards mid-load
    set({
      messages: state.messages,
      status: state.inFlight ? 'thinking' : state.error ? 'error' : 'idle',
      error: state.error
    });
  },

  send: async (boardId, text) => {
    // Optimistic echo: the real transcript replaces this when the turn lands.
    set((s) => ({
      status: 'thinking',
      error: null,
      messages: [...s.messages, { role: 'user', blocks: [{ type: 'text', text }] }]
    }));
    try {
      await window.fleet.kanban.pmSend({ boardId, text });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  reset: async (boardId) => {
    await window.fleet.kanban.pmReset(boardId);
    await get().loadState(boardId); // re-sync from main — the source of truth
  },

  applyStatus: (status, error) => set({ status, error: error ?? null }),
  applyTranscript: (messages) => set({ messages })
}));
