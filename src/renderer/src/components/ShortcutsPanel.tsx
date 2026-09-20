import { Overlay } from './Overlay';
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
  return (
    <Overlay open={isOpen} onClose={onClose}>
      <div className="bg-fleet-surface border border-fleet-border-strong rounded-lg w-[360px] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-fleet-border">
          <h2 className="text-sm font-semibold text-fleet-text">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-fleet-text-subtle transition hover:text-fleet-text active:scale-90"
          >
            &times;
          </button>
        </div>
        <div className="p-4 space-y-2">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={keys} className="flex items-center justify-between">
              <span className="text-sm text-fleet-text-secondary">{action}</span>
              <kbd className="text-xs bg-fleet-surface-2 text-fleet-text-muted px-2 py-0.5 rounded border border-fleet-border-strong">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
