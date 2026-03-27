import { create } from 'zustand';
import type { ImageGenerationMeta, ImageSettings } from '../../../shared/types';

type ImageStore = {
  generations: ImageGenerationMeta[];
  config: ImageSettings | null;
  isLoaded: boolean;
  loadGenerations: () => Promise<void>;
  loadConfig: () => Promise<void>;
  generate: (opts: {
    prompt: string;
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }) => Promise<{ id: string }>;
  edit: (opts: {
    prompt: string;
    images: string[];
    provider?: string;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    outputFormat?: string;
    numImages?: number;
  }) => Promise<{ id: string }>;
  retry: (id: string) => Promise<void>;
  deleteGeneration: (id: string) => Promise<void>;
  updateConfig: (partial: Partial<ImageSettings>) => Promise<void>;
};

export const useImageStore = create<ImageStore>((set) => ({
  generations: [],
  config: null,
  isLoaded: false,

  loadGenerations: async () => {
    const generations = await window.fleet.images.list();
    set({ generations, isLoaded: true });
  },

  loadConfig: async () => {
    const config = await window.fleet.images.getConfig();
    set({ config });
  },

  generate: async (opts) => {
    const result = await window.fleet.images.generate(opts);
    return result;
  },

  edit: async (opts) => {
    const result = await window.fleet.images.edit(opts);
    return result;
  },

  retry: async (id) => {
    await window.fleet.images.retry(id);
  },

  deleteGeneration: async (id) => {
    await window.fleet.images.delete(id);
    set((state) => ({
      generations: state.generations.filter((g) => g.id !== id)
    }));
  },

  updateConfig: async (partial) => {
    await window.fleet.images.setConfig(partial);
    const config = await window.fleet.images.getConfig();
    set({ config });
  }
}));
