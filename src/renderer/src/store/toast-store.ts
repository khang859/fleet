import { create } from 'zustand';

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  id: string;
  message: string;
  duration?: number;
  action?: ToastAction;
  /** Set while the toast plays its exit animation, just before removal. */
  closing?: boolean;
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

// Time the toast stays mounted after `closing` is set, to let the exit
// animation finish. Must be >= the exit-animation duration in ToastContainer.
const EXIT_MS = 180;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, options) => {
    const duration = options?.duration ?? 4000;
    // Deduplicate: if the same message is already showing (and not mid-exit), skip
    const existing = useToastStore.getState().toasts;
    if (existing.some((t) => t.message === message && !t.closing)) return;
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, duration, action: options?.action }] }));
    setTimeout(() => useToastStore.getState().dismiss(id), duration);
  },
  dismiss: (id) => {
    // Two-phase: flag the toast so it animates out, then remove it. No-op if the
    // toast is gone (e.g. the auto-dismiss timer firing after a manual dismiss)
    // or already mid-exit, so we never schedule a duplicate removal timer.
    const toast = useToastStore.getState().toasts.find((t) => t.id === id);
    if (!toast || toast.closing) return;
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)) }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, EXIT_MS);
  }
}));
