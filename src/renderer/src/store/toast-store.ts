import { create } from 'zustand';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type Toast = {
  id: string;
  message: string;
  duration?: number;
  action?: ToastAction;
};

type ShowOptions = {
  duration?: number;
  action?: ToastAction;
};

type ToastStore = {
  toasts: Toast[];
  show: (message: string, options?: ShowOptions) => void;
  dismiss: (id: string) => void;
};

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, options) => {
    const duration = options?.duration ?? 4000;
    // Deduplicate: if the same message is already showing, skip
    const existing = useToastStore.getState().toasts;
    if (existing.some((t) => t.message === message)) return;
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, duration, action: options?.action }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, duration);
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
