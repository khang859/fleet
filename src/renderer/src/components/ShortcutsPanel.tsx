import { ALL_SHORTCUTS, formatShortcut } from '../lib/shortcuts';

const SHORTCUTS = ALL_SHORTCUTS.filter((s) => s.id !== 'command-palette').map((s) => ({
  keys: formatShortcut(s),
  action: s.label
}));

type ShortcutsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ShortcutsPanel({ isOpen, onClose }: ShortcutsPanelProps): React.JSX.Element | null {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[360px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-white">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">
            &times;
          </button>
        </div>
        <div className="p-4 space-y-2">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="flex items-center justify-between">
              <span className="text-sm text-neutral-300">{action}</span>
              <kbd className="text-xs bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded border border-neutral-700">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
