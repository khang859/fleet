import { create } from 'zustand';
import type { AnnotationMeta } from '../../../shared/types';

type AnnotationDetail = {
  success: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  context?: string;
  elements?: Array<{
    selector: string;
    tag: string;
    id: string | null;
    classes: string[];
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    attributes: Record<string, string>;
    comment?: string;
    screenshotPath?: string;
    boxModel?: {
      content: { width: number; height: number };
      padding: { top: number; right: number; bottom: number; left: number };
      border: { top: number; right: number; bottom: number; left: number };
      margin: { top: number; right: number; bottom: number; left: number };
    };
    accessibility?: {
      role: string | null;
      name: string | null;
      focusable: boolean;
      disabled: boolean;
    };
    keyStyles?: Record<string, string>;
  }>;
};

type AnnotationStoreState = {
  annotations: AnnotationMeta[];
  isLoaded: boolean;
  loadAnnotations: () => Promise<void>;
  getDetail: (id: string) => Promise<AnnotationDetail | null>;
  deleteAnnotation: (id: string) => Promise<void>;
  startAnnotation: (url?: string) => Promise<{ resultPath: string }>;
};

export const useAnnotationStore = create<AnnotationStoreState>((set) => ({
  annotations: [],
  isLoaded: false,

  loadAnnotations: async (): Promise<void> => {
    const annotations = await window.fleet.annotate.list();
    set({ annotations, isLoaded: true });
  },

  getDetail: async (id: string): Promise<AnnotationDetail | null> => {
    const result = await window.fleet.annotate.get(id);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- IPC bridge returns unknown
    return result as AnnotationDetail | null;
  },

  deleteAnnotation: async (id: string): Promise<void> => {
    await window.fleet.annotate.delete(id);
    set((state) => ({
      annotations: state.annotations.filter((a) => a.id !== id)
    }));
  },

  startAnnotation: async (url?: string): Promise<{ resultPath: string }> => {
    const result = await window.fleet.annotate.start({ url });
    return result;
  }
}));
