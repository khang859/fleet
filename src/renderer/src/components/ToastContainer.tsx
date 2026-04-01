import { useToastStore } from '../store/toast-store';

export function ToastContainer(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg text-sm"
        >
          <span className="text-neutral-300">{toast.message}</span>
          {toast.action && (
            <button
              className="text-blue-400 hover:text-blue-300 font-medium whitespace-nowrap"
              onClick={() => {
                toast.action?.onClick();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="text-neutral-500 hover:text-neutral-300"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
