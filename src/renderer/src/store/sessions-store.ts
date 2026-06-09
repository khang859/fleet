// src/renderer/src/store/sessions-store.ts
import { create } from 'zustand';
import type { SessionAgent, SessionSummary, SessionTranscript } from '../../../shared/sessions';

type SelectedKey = { agent: SessionAgent; id: string; cwd: string };

type SessionsStoreState = {
  sessions: SessionSummary[];
  isLoaded: boolean;
  selected: SelectedKey | null;
  transcript: SessionTranscript | null;
  isLoadingTranscript: boolean;
  load: () => Promise<void>;
  select: (s: SessionSummary) => Promise<void>;
};

export const useSessionsStore = create<SessionsStoreState>((set, get) => ({
  sessions: [],
  isLoaded: false,
  selected: null,
  transcript: null,
  isLoadingTranscript: false,

  load: async () => {
    const sessions = await window.fleet.sessions.list();
    set({ sessions, isLoaded: true });
    // If a session is open and still present, refresh its transcript.
    const sel = get().selected;
    if (sel && sessions.some((s) => s.agent === sel.agent && s.id === sel.id)) {
      const transcript = await window.fleet.sessions.read(sel);
      set({ transcript });
    }
  },

  select: async (s) => {
    const selected = { agent: s.agent, id: s.id, cwd: s.cwd };
    set({ selected, isLoadingTranscript: true, transcript: null });
    const transcript = await window.fleet.sessions.read(selected);
    // Ignore if the user selected something else meanwhile.
    if (get().selected?.id === s.id) set({ transcript, isLoadingTranscript: false });
  }
}));
