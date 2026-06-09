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
  transcriptError: string | null;
  load: () => Promise<void>;
  select: (s: SessionSummary) => Promise<void>;
};

const READ_FAILED = 'This session could not be loaded. The file may have been moved or deleted.';

export const useSessionsStore = create<SessionsStoreState>((set, get) => ({
  sessions: [],
  isLoaded: false,
  selected: null,
  transcript: null,
  isLoadingTranscript: false,
  transcriptError: null,

  load: async () => {
    const sessions = await window.fleet.sessions.list();
    set({ sessions, isLoaded: true });
    // If a session is open and still present, refresh its transcript.
    const sel = get().selected;
    if (sel && sessions.some((s) => s.agent === sel.agent && s.id === sel.id)) {
      try {
        const transcript = await window.fleet.sessions.read(sel);
        const cur = get().selected;
        if (cur?.id === sel.id && cur?.agent === sel.agent && transcript) set({ transcript });
      } catch {
        // ignore refresh failure; keep existing transcript
      }
    }
  },

  select: async (s) => {
    const selected = { agent: s.agent, id: s.id, cwd: s.cwd };
    set({ selected, isLoadingTranscript: true, transcript: null, transcriptError: null });
    const isCurrent = (): boolean => {
      const cur = get().selected;
      return cur?.id === s.id && cur?.agent === s.agent;
    };
    try {
      const transcript = await window.fleet.sessions.read(selected);
      if (!isCurrent()) return;
      if (transcript) set({ transcript, isLoadingTranscript: false });
      else set({ isLoadingTranscript: false, transcriptError: READ_FAILED });
    } catch {
      if (isCurrent()) set({ isLoadingTranscript: false, transcriptError: READ_FAILED });
    }
  }
}));
