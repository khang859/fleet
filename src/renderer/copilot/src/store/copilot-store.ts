import { create } from 'zustand';
import { createLogger } from '../copilot-logger';
import type {
  CopilotSession,
  CopilotSettings,
  CopilotChatMessage,
} from '../../../../shared/types';

const log = createLogger('store');

declare global {
  interface Window {
    copilot: import('../../../../preload/copilot').CopilotApi;
  }
}

type CopilotView = 'sessions' | 'detail' | 'settings';

type CopilotStoreState = {
  expanded: boolean;
  view: CopilotView;
  selectedSessionId: string | null;

  sessions: CopilotSession[];
  settings: CopilotSettings | null;
  hookInstalled: boolean;

  chatMessages: CopilotChatMessage[];
  chatLoading: boolean;

  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  setView: (view: CopilotView) => void;
  selectSession: (sessionId: string) => void;
  backToList: () => void;

  setSessions: (sessions: CopilotSession[]) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<CopilotSettings>) => Promise<void>;
  respondPermission: (toolUseId: string, decision: 'allow' | 'deny', reason?: string) => Promise<void>;
  checkHookStatus: () => Promise<void>;
  installHooks: () => Promise<void>;
  uninstallHooks: () => Promise<void>;

  loadChatHistory: (sessionId: string, cwd: string) => Promise<void>;
  setChatMessages: (sessionId: string, messages: CopilotChatMessage[]) => void;
  sendMessage: (sessionId: string, message: string) => Promise<boolean>;
};

export const useCopilotStore = create<CopilotStoreState>((set, get) => ({
  expanded: false,
  view: 'sessions',
  selectedSessionId: null,

  sessions: [],
  settings: null,
  hookInstalled: false,

  chatMessages: [],
  chatLoading: false,

  setExpanded: (expanded) => {
    log.info('setExpanded (from main)', { expanded });
    set({ expanded, view: expanded ? get().view : 'sessions' });
  },

  toggleExpanded: () => {
    log.info('toggleExpanded → sending IPC to main');
    window.copilot.toggleExpanded();
  },

  setView: (view) => set({ view }),

  selectSession: (sessionId) => {
    log.debug('selectSession', { sessionId });
    set({ selectedSessionId: sessionId, view: 'detail' });
  },

  backToList: () => set({ view: 'sessions', selectedSessionId: null, chatMessages: [] }),

  setSessions: (sessions) => set({ sessions }),

  loadSettings: async () => {
    const settings = await window.copilot.getSettings();
    const hookInstalled = await window.copilot.hookStatus();
    log.debug('loadSettings', { settings, hookInstalled });
    set({ settings, hookInstalled });
  },

  updateSettings: async (partial) => {
    log.debug('updateSettings', { keys: Object.keys(partial) });
    await window.copilot.setSettings(partial);
    const settings = await window.copilot.getSettings();
    set({ settings });
  },

  respondPermission: async (toolUseId, decision, reason) => {
    log.info('respondPermission', { toolUseId, decision });
    await window.copilot.respondPermission(toolUseId, decision, reason);
  },

  checkHookStatus: async () => {
    const hookInstalled = await window.copilot.hookStatus();
    set({ hookInstalled });
  },

  installHooks: async () => {
    await window.copilot.installHooks();
    set({ hookInstalled: true });
  },

  uninstallHooks: async () => {
    await window.copilot.uninstallHooks();
    set({ hookInstalled: false });
  },

  loadChatHistory: async (sessionId, cwd) => {
    set({ chatLoading: true });
    const messages = await window.copilot.getChatHistory(sessionId, cwd);
    if (get().selectedSessionId === sessionId) {
      set({ chatMessages: messages, chatLoading: false });
    } else {
      set({ chatLoading: false });
    }
  },

  setChatMessages: (sessionId, messages) => {
    if (get().selectedSessionId === sessionId) {
      set({ chatMessages: messages });
    }
  },

  sendMessage: async (sessionId, message) => {
    return window.copilot.sendMessage(sessionId, message);
  },
}));
