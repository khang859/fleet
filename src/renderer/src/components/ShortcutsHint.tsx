import { useState } from 'react';

const SHORTCUTS = [
  { keys: 'Ctrl+T', action: 'New tab' },
  { keys: 'Ctrl+W', action: 'Close pane' },
  { keys: 'Ctrl+D', action: 'Split horizontal' },
  { keys: 'Ctrl+Shift+D', action: 'Split vertical' },
  { keys: 'Ctrl+[ / ]', action: 'Navigate panes' },
  { keys: 'Ctrl+1-9', action: 'Switch tab' },
  { keys: 'Ctrl+F', action: 'Search' },
  { keys: 'Ctrl+Shift+V', action: 'Toggle visualizer' },
];

export function ShortcutsHint() {
  const [open, setOpen] = useState(false);

  return (
    <div className="absolute bottom-3 right-3 z-30">
      {open && (
        <div className="mb-2 bg-neutral-800/95 backdrop-blur border border-neutral-700 rounded-lg px-3 py-2 text-xs shadow-lg min-w-[180px]">
          <div className="text-neutral-400 uppercase tracking-wider text-[10px] mb-1.5">Shortcuts</div>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex justify-between gap-4 py-0.5">
              <span className="text-neutral-300">{s.action}</span>
              <kbd className="text-neutral-500 font-mono">{s.keys}</kbd>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="w-6 h-6 rounded-full bg-neutral-800/80 border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/80 text-xs flex items-center justify-center transition-colors"
      >
        ?
      </button>
    </div>
  );
}
