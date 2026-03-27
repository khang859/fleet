import { create } from 'zustand';

type VisualizerStore = {
  isVisible: boolean;
  panelMode: 'drawer' | 'tab';

  toggleVisible: () => void;
  setPanelMode: (mode: 'drawer' | 'tab') => void;
};

export const useVisualizerStore = create<VisualizerStore>((set) => ({
  isVisible: false,
  panelMode: 'drawer',

  toggleVisible: () => set((state) => ({ isVisible: !state.isVisible })),
  setPanelMode: (mode) => set({ panelMode: mode })
}));
