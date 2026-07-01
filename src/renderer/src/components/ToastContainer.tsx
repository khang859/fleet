import { overlayTiming } from '../lib/motion';
import { useToastStore } from '../store/toast-store';

// Slide up + fade on enter, reverse on exit. `closing` drives the data-state;
// the store keeps the toast mounted long enough for the exit to play.
const toastAnim = `${overlayTiming} data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-2`;

export function ToastContainer(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-state={toast.closing ? 'closed' : 'open'}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg shadow-lg text-sm ${toastAnim}`}
        >
          <span className="text-neutral-300">{toast.message}</span>
          {toast.action && (
            <button
              className="text-blue-400 hover:text-blue-300 font-medium whitespace-nowrap transition active:scale-95"
              onClick={() => {
                toast.action?.onClick();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="text-neutral-500 hover:text-neutral-300 transition active:scale-90"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
