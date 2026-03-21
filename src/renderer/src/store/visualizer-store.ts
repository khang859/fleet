import { create } from 'zustand';
import type { AgentVisualState } from '../../../shared/types';

type VisualizerStore = {
  agents: AgentVisualState[];
  isVisible: boolean;
  panelMode: 'drawer' | 'tab';

  setAgents: (agents: AgentVisualState[]) => void;
  toggleVisible: () => void;
  setPanelMode: (mode: 'drawer' | 'tab') => void;
};

export const useVisualizerStore = create<VisualizerStore>((set) => ({
  agents: [],
  isVisible: false,
  panelMode: 'drawer',

  setAgents: (agents) => set({ agents }),
  toggleVisible: () => set((state) => ({ isVisible: !state.isVisible })),
  setPanelMode: (mode) => set({ panelMode: mode })
}));
