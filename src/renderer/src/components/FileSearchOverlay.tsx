import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspace-store';
import { quotePathForShell } from '../lib/shell-utils';
import { getFileIcon } from '../lib/file-icons';
import { z } from 'zod';
import type { FileSearchResult } from '../../../shared/ipc-api';

const RECENT_STORAGE_KEY = 'fleet:file-search-recent';
const MAX_RECENT = 20;

const fileSearchResultSchema = z.array(
  z.object({
    path: z.string(),
    name: z.string(),
    parentDir: z.string(),
    modifiedAt: z.number(),
    size: z.number()
  })
);

// --- Recent files LRU ---

function getRecentFiles(): FileSearchResult[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = fileSearchResultSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function addRecentFile(file: FileSearchResult): void {
  const recent = getRecentFiles().filter((f) => f.path !== file.path);
  recent.unshift(file);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
}

// --- Relative time formatting ---

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

// --- Highlight matched characters ---

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
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
        </span>
      );
      qi++;
    } else {
      chars.push(<span key={i}>{text[i]}</span>);
    }
  }
  return <>{chars}</>;
}

// --- Scope pill with dropdown ---

function ScopePill({
  scope,
  scopeLabel,
  onSetScope
}: {
  scope: string | undefined;
  scopeLabel: string;
  onSetScope: (s: string | undefined) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handlePickFolder = async (): Promise<void> => {
    setOpen(false);
    const picked = await window.fleet.showFolderPicker();
    if (picked) onSetScope(picked);
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-neutral-800 text-neutral-400 rounded border border-neutral-700 hover:text-neutral-200"
      >
        {scopeLabel}
        <X size={10} className={scope ? '' : 'hidden'} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg py-1 min-w-[140px]">
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => {
                onSetScope(undefined);
                setOpen(false);
              }}
            >
              Everywhere
            </button>
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => {
                onSetScope(window.fleet.homeDir);
                setOpen(false);
              }}
            >
              Home (~)
            </button>
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => void handlePickFolder()}
            >
              Choose folder...
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Props ---

type FileSearchOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
};

// --- Component ---

export function FileSearchOverlay({
  isOpen,
  onClose
}: FileSearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setScope(undefined);
      setResults(getRecentFiles());
      setSelectedIndex(0);
      setIsLoading(false);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (!isOpen) return;

    if (!query.trim()) {
      setResults(getRecentFiles());
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const id = ++requestIdRef.current;
      void window.fleet.file
        .search({
          requestId: id,
          query: query.trim(),
          scope,
          limit: 20
        })
        .then((res) => {
          // Discard stale responses
          if (id !== requestIdRef.current) return;
          setIsLoading(false);
          if (res.success) {
            setResults(res.results);
            setError(null);
          } else {
            setResults([]);
            setError(res.error);
          }
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, query, scope]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      if (!activePaneId) return;
      const quoted = quotePathForShell(file.path, window.fleet.platform) + ' ';
      window.fleet.pty.input({ paneId: activePaneId, data: quoted });
      addRecentFile(file);
      onClose();
    },
    [activePaneId, onClose]
  );

  const handleScopeToParent = useCallback(() => {
    const file = results[selectedIndex];
    if (file) {
      setScope(file.parentDir);
    }
  }, [results, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
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
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleScopeToParent();
    } else if (e.key === 'Backspace' && query === '' && scope) {
      e.preventDefault();
      setScope(undefined);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  const scopeLabel = scope ? scope.replace(window.fleet.homeDir, '~') : 'Everywhere';

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Search size={14} className="text-neutral-500 shrink-0" />
          <ScopePill scope={scope} scopeLabel={scopeLabel} onSetScope={setScope} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={scope ? 'Search in folder...' : 'Search files on disk...'}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          {isLoading && <span className="text-xs text-neutral-500">Searching...</span>}
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto py-1">
          {!query && results.length > 0 && (
            <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
              Recent
            </div>
          )}
          {error ? (
            <div className="px-3 py-4 text-sm text-red-400/80 text-center">{error}</div>
          ) : results.length === 0 && !isLoading ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              {query ? 'No files found' : 'No recent files'}
            </div>
          ) : (
            results.slice(0, 10).map((file, i) => (
              <button
                key={file.path}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  i === selectedIndex
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => handleSelect(file)}
              >
                <span className="text-neutral-500 shrink-0">{getFileIcon(file.name, 14)}</span>
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate font-medium">
                    <HighlightedText text={file.name} query={query} />
                  </span>
                  <span className="truncate text-xs text-neutral-600">
                    {file.parentDir.replace(window.fleet.homeDir, '~')}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-600 shrink-0">
                  {relativeTime(file.modifiedAt)}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
          {!activePaneId ? (
            <span className="text-amber-500/80">No active terminal</span>
          ) : (
            <>
              <span>↑↓ navigate</span>
              <span>↵ paste</span>
              <span>⇥ scope to folder</span>
              <span>esc dismiss</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
