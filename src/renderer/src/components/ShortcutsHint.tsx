export function ShortcutsHint() {
  return (
    <div className="absolute bottom-3 right-3 z-30">
      <button
        onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-shortcuts'))}
        className="w-6 h-6 rounded-full bg-neutral-800/80 border border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700/80 text-xs flex items-center justify-center transition-colors"
        title="Keyboard Shortcuts (Ctrl+/)"
      >
        ?
      </button>
    </div>
  );
}
