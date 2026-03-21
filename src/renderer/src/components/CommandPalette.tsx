import { useState, useEffect, useRef, useMemo } from 'react';
import { createCommandRegistry, fuzzyMatch, formatCommandShortcut } from '../lib/commands';

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo(() => createCommandRegistry(), []);

  const filtered = useMemo(() => {
    return commands.filter((cmd) => fuzzyMatch(query, cmd.label));
  }, [commands, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Defer focus so the input is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!isOpen) return null;

  const executeSelected = () => {
    const cmd = filtered[selectedIndex];
    if (cmd) {
      onClose();
      cmd.execute();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeSelected();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[480px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-neutral-800">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="w-full bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
        </div>
        <div className="overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              No matching commands
            </div>
          ) : (
            filtered.map((cmd, i) => {
              const shortcutLabel = formatCommandShortcut(cmd);
              return (
                <button
                  key={cmd.id}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
                    i === selectedIndex
                      ? 'bg-neutral-700 text-white'
                      : 'text-neutral-300 hover:bg-neutral-800'
                  }`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => {
                    onClose();
                    cmd.execute();
                  }}
                >
                  <span>{cmd.label}</span>
                  {shortcutLabel && (
                    <kbd className="text-xs text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded border border-neutral-700">
                      {shortcutLabel}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
