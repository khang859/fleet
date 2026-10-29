import { create } from 'zustand';
import { createLogger } from '../copilot-logger';
import type { CopilotSession, CopilotSettings, CopilotChatMessage } from '../../../../shared/types';
import type { CopilotApi } from '../../../../preload/copilot';
import type { PlanApprovalMode } from '../../../../shared/claude-sessions';
import { firstOpenPermission, sortSessions, turnFinished } from '../lib/sessions';

const log = createLogger('store');

declare global {
  interface Window {
    copilot: CopilotApi;
  }
}

type CopilotView = 'sessions' | 'detail' | 'mascots';

/** An answer on its way, or one Fleet could not deliver because nothing holds the request. */
export type PermissionStatus = 'sending' | 'failed';

/** How long the mascot plays its "turn done" frames. */
const CELEBRATE_MS = 2500;
let celebrateTimer = 0;

type CopilotStoreState = {
  expanded: boolean;
  view: CopilotView;
  selectedSessionId: string | null;

  sessions: CopilotSession[];
  settings: CopilotSettings | null;
  hookInstalled: boolean;
  claudeDetected: boolean;
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  showAllWorkspaces: boolean;

  chatMessages: CopilotChatMessage[];
  chatLoading: boolean;

  /** True for a moment after a session finishes its turn. */
  celebrating: boolean;
  /** Keyed by tool use id; a request with no entry has not been answered here. */
  permissionStatus: Record<string, PermissionStatus | undefined>;

  setExpanded: (expanded: boolean) => void;
  toggleExpanded: () => void;
  setView: (view: CopilotView) => void;
  selectSession: (sessionId: string) => void;
  backToList: () => void;

  setSessions: (sessions: CopilotSession[]) => void;
  setActiveWorkspace: (workspaceId: string, workspaceName: string) => void;
  setShowAllWorkspaces: (show: boolean) => Promise<void>;
  filteredSessions: () => CopilotSession[];
  /** The request the Y and N keys answer: the first one on screen. */
  topPermissionId: () => string | null;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<CopilotSettings>) => Promise<void>;
  /**
   * `suggestion` allows one of the request's `suggestions` along with it, by its place.
   * `mode` is the mode a plan is approved into; `reason` on a deny reaches Claude.
   */
  respondPermission: (
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string,
    suggestion?: number,
    mode?: PlanApprovalMode
  ) => Promise<void>;
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
  claudeDetected: true, // optimistic default
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  showAllWorkspaces: false,

  chatMessages: [],
  chatLoading: false,

  celebrating: false,
  permissionStatus: {},

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

  setSessions: (sessions) => {
    const { sessions: previous, permissionStatus } = get();
    // A request that is no longer pending has been settled, so its status is done with.
    const pending = new Set(sessions.flatMap((s) => s.pendingPermissions.map((p) => p.toolUseId)));
    const kept = Object.entries(permissionStatus).filter(([id]) => pending.has(id));
    set({ sessions, permissionStatus: Object.fromEntries(kept) });
    if (turnFinished(previous, sessions)) {
      window.clearTimeout(celebrateTimer);
      set({ celebrating: true });
      celebrateTimer = window.setTimeout(() => set({ celebrating: false }), CELEBRATE_MS);
    }
  },

  setActiveWorkspace: (workspaceId, workspaceName) => {
    set({ activeWorkspaceId: workspaceId, activeWorkspaceName: workspaceName });
  },

  setShowAllWorkspaces: async (show) => {
    set({ showAllWorkspaces: show });
    await window.copilot.setSettings({ showAllWorkspaces: show });
  },

  filteredSessions: () => {
    const { sessions, showAllWorkspaces, activeWorkspaceId } = get();
    if (showAllWorkspaces) return sessions;
    return sessions.filter((s) => !s.workspaceId || s.workspaceId === activeWorkspaceId);
  },

  topPermissionId: () => {
    const { view, selectedSessionId, sessions, permissionStatus } = get();
    const candidates =
      view === 'detail'
        ? sessions.filter((s) => s.sessionId === selectedSessionId)
        : view === 'sessions'
          ? [...get().filteredSessions()].sort(sortSessions)
          : [];
    return firstOpenPermission(candidates, permissionStatus);
  },

  loadSettings: async () => {
    const settings = await window.copilot.getSettings();
    const hookInstalled = await window.copilot.hookStatus();
    let claudeDetected = true;
    try {
      const status = await window.copilot.serviceStatus();
      claudeDetected = status.claudeDetected;
    } catch {
      // serviceStatus not available (older preload), assume true
    }
    log.debug('loadSettings', { settings, hookInstalled, claudeDetected });
    set({
      settings,
      hookInstalled,
      claudeDetected,
      showAllWorkspaces: settings.showAllWorkspaces
    });
  },

  updateSettings: async (partial) => {
    log.debug('updateSettings', { keys: Object.keys(partial) });
    await window.copilot.setSettings(partial);
    const settings = await window.copilot.getSettings();
    set({ settings });
  },

  respondPermission: async (toolUseId, decision, reason, suggestion, mode) => {
    // A second answer to the same request would only race the first.
    if (get().permissionStatus[toolUseId]) return;
    log.info('respondPermission', { toolUseId, decision, mode });
    const setStatus = (status: PermissionStatus): void =>
      set((s) => ({ permissionStatus: { ...s.permissionStatus, [toolUseId]: status } }));
    setStatus('sending');
    const delivered = await window.copilot
      .respondPermission(toolUseId, decision, reason, suggestion, mode)
      .catch(() => false);
    // Delivered stays 'sending' until the session update removes the request.
    if (!delivered) setStatus('failed');
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
  }
}));
