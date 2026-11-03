import { formatShortcut, getShortcut } from '../lib/shortcuts';

export function ShortcutsHint(): React.JSX.Element {
  const shortcutsDef = getShortcut('shortcuts');
  const hint = shortcutsDef ? formatShortcut(shortcutsDef) : 'Ctrl+/';

  return (
    <button
      onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'))}
      className="w-6 h-6 cursor-pointer rounded-full bg-fleet-glass-chrome border border-fleet-border text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2 text-[12px] flex items-center justify-center transition-colors active:scale-90"
      style={{ WebkitAppRegion: 'no-drag' }}
      title={`Keyboard Shortcuts (${hint})`}
    >
      ?
    </button>
  );
}
