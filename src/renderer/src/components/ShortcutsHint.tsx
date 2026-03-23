import { formatShortcut, getShortcut } from '../lib/shortcuts';

export function ShortcutsHint(): React.JSX.Element {
  const shortcutsDef = getShortcut('shortcuts');
  const hint = shortcutsDef ? formatShortcut(shortcutsDef) : 'Ctrl+/';

  const platform = window.fleet.platform;
  const positionClass = platform === 'darwin' ? 'ml-auto mr-3' : 'ml-3';

  return (
    <button
      onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'))}
      className={`${positionClass} w-6 h-6 rounded-full bg-neutral-800/80 border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/80 text-xs flex items-center justify-center transition-colors`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={`Keyboard Shortcuts (${hint})`}
    >
      ?
    </button>
  );
}
