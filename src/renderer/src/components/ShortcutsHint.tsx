import { formatShortcut, getShortcut } from '../lib/shortcuts';

export function ShortcutsHint(): React.JSX.Element {
  const shortcutsDef = getShortcut('shortcuts');
  const hint = shortcutsDef ? formatShortcut(shortcutsDef) : 'Ctrl+/';

  const platform = window.fleet.platform;
  const positionClass = platform === 'darwin' ? 'ml-auto mr-3' : 'ml-3';

  return (
    <button
      onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'))}
      className={`${positionClass} w-5 h-5 rounded-full bg-fleet-glass-chrome border border-fleet-border text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2 text-[11px] flex items-center justify-center transition-colors active:scale-90`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={`Keyboard Shortcuts (${hint})`}
    >
      ?
    </button>
  );
}
