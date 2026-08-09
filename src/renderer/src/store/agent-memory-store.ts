import { create } from 'zustand';
import type { MemoryDescriptor, MemorySource } from '../../../shared/agent-memory';

/**
 * The notes earlier sessions wrote, as the settings pane sees them.
 *
 * Split from `agent-store` for the reason the skills store is: one list that
 * changes only when the user or a turn changes it, and folding it into the
 * per-pane store would re-render it on every transcript keystroke.
 *
 * Smaller than the skills store, and the missing half is the point. There is no
 * detect, no fetch, no install - the agent writes these itself, so the only
 * things a person does here are look and remove.
 *
 * `cwd` is remembered from the last load so `remove` can name the same folder
 * without the caller passing it twice. The project tier lives inside whichever
 * repository the pane is open on, and a remove aimed at the wrong folder would
 * quietly do nothing.
 */
type AgentMemoryState = {
  entries: MemoryDescriptor[];
  /** False until the first read lands, so the pane can tell empty from not-yet. */
  loaded: boolean;
  /** The folder the current list was read for. */
  cwd: string | null;

  load: (cwd: string) => Promise<void>;
  remove: (scope: MemorySource, name: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
};

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  entries: [],
  loaded: false,
  cwd: null,

  load: async (cwd) => {
    set({ entries: await window.fleet.agent.memory.list(cwd), loaded: true, cwd });
  },

  remove: async (scope, name) => {
    const { cwd } = get();
    if (cwd === null) return;
    await window.fleet.agent.memory.remove(scope, name, cwd);
    await get().load(cwd);
  },

  reveal: async (path) => {
    await window.fleet.agent.memory.reveal(path);
  }
}));
