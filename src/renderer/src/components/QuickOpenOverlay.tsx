import { useState, useEffect, useRef, useCallback } from 'react';
import { useWorkspaceStore } from '../store/workspace-store';
import { fuzzyMatch } from '../lib/commands';

type FileEntry = {
  path: string;
  relativePath: string;
  name: string;
};

type QuickOpenOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Root directory to search files in (current sector/cwd). */
  rootDir?: string;
};

/** Highlight matched characters in a string based on query. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <span>{text}</span>;

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const chars: React.ReactNode[] = [];
  let qi = 0;

  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      chars.push(
        <span key={i} className="text-blue-400 font-semibold">
          {text[i]}
        </span>,
      );
      qi++;
    } else {
      chars.push(<span key={i}>{text[i]}</span>);
    }
  }

  return <>{chars}</>;
}

export function QuickOpenOverlay({ isOpen, onClose, rootDir }: QuickOpenOverlayProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allFiles, setAllFiles] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { recentFiles, openFile } = useWorkspaceStore();

  // Load file listing when overlay opens and rootDir is available
  useEffect(() => {
    if (!isOpen || !rootDir) return;
    setIsLoading(true);
    window.fleet.file.list(rootDir).then((result) => {
      if (result.success) {
        setAllFiles(result.files);
      }
      setIsLoading(false);
    });
  }, [isOpen, rootDir]);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const results: FileEntry[] = query
    ? allFiles.filter((f) => fuzzyMatch(query, f.relativePath) || fuzzyMatch(query, f.name)).slice(0, 8)
    : recentFiles
        .slice(0, 10)
        .map((p) => ({
          path: p,
          relativePath: rootDir && p.startsWith(rootDir) ? p.slice(rootDir.length).replace(/^\//, '') : p,
          name: p.split('/').pop() ?? p,
        }));

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (file: FileEntry) => {
      onClose();
      openFile(file.path);
    },
    [onClose, openFile],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = results[selectedIndex];
      if (file) handleSelect(file);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <svg
            className="text-neutral-500 shrink-0"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files..."
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          {isLoading && (
            <span className="text-xs text-neutral-500">Loading...</span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto py-1">
          {results.length === 0 && !isLoading ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              {query ? 'No matching files' : 'No recent files'}
            </div>
          ) : (
            results.map((file, i) => (
              <button
                key={file.path}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  i === selectedIndex ? 'bg-neutral-700 text-white' : 'text-neutral-300 hover:bg-neutral-800'
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => handleSelect(file)}
              >
                {/* File icon */}
                <svg
                  className="text-neutral-500 shrink-0"
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" />
                  <polyline points="9 2 9 6 13 6" />
                </svg>
                {/* Filename + path */}
                <div className="flex flex-col min-w-0">
                  <span className="truncate font-medium">
                    <HighlightedText text={file.name} query={query} />
                  </span>
                  {file.relativePath !== file.name && (
                    <span className="truncate text-xs text-neutral-500">
                      {file.relativePath}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc dismiss</span>
          </div>
        )}
      </div>
    </div>
  );
}
