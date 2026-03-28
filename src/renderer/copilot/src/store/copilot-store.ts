import { create } from 'zustand';
import { createLogger } from '../copilot-logger';
import type {
  CopilotSession,
  CopilotSettings,
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
};

export const useCopilotStore = create<CopilotStoreState>((set, get) => ({
  expanded: false,
  view: 'sessions',
  selectedSessionId: null,

  sessions: [],
  settings: null,
  hookInstalled: false,

  setExpanded: (expanded) => {
    log.debug('setExpanded', { expanded });
    set({ expanded });
    window.copilot.setExpanded(expanded);
  },

  toggleExpanded: () => {
    const next = !get().expanded;
    log.debug('toggleExpanded', { next });
    set({ expanded: next, view: next ? get().view : 'sessions' });
    window.copilot.setExpanded(next);
  },

  setView: (view) => set({ view }),

  selectSession: (sessionId) => {
    log.debug('selectSession', { sessionId });
    set({ selectedSessionId: sessionId, view: 'detail' });
  },

  backToList: () => set({ view: 'sessions', selectedSessionId: null }),

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
}));
