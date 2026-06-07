import { X } from 'lucide-react';

export function EnvEditorModal({
  isOpen,
  onClose,
  cwd
}: {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
}): React.JSX.Element | null {
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[820px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Env Editor</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-6 text-sm text-neutral-400">cwd: {cwd ?? '(none)'}</div>
      </div>
    </div>
  );
}
