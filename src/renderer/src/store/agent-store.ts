import { create } from 'zustand';
import type { AgentCatalog } from '../../../shared/agent-types';
import { createLogger } from '../logger';

const log = createLogger('store:agent');

/**
 * State backing the agent settings tab. The settings themselves live in the
 * app settings store under `ai.agent`; what is agent-specific is the models.dev
 * catalog and the OpenRouter key, which is the same key Chat stores.
 */
type AgentStoreState = {
  catalog: AgentCatalog | null;
  loadingModels: boolean;
  keyPresent: boolean;
  /** Loads the catalog once per session; `refresh` re-downloads it. */
  loadModels: (refresh?: boolean) => Promise<void>;
  loadKey: () => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  clearKey: () => Promise<void>;
};

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  catalog: null,
  loadingModels: false,
  keyPresent: false,

  loadModels: async (refresh = false) => {
    if (get().loadingModels) return;
    if (get().catalog && !refresh) return;
    set({ loadingModels: true });
    try {
      const catalog = await window.fleet.agent.listModels(refresh);
      log.debug('loadModels', { count: catalog.models.length, source: catalog.source });
      set({ catalog });
    } finally {
      set({ loadingModels: false });
    }
  },

  loadKey: async () => {
    set({ keyPresent: await window.fleet.chat.hasKey() });
  },

  saveKey: async (key) => {
    await window.fleet.chat.setKey(key);
    set({ keyPresent: true });
  },

  clearKey: async () => {
    await window.fleet.chat.clearKey();
    set({ keyPresent: false });
  }
}));
