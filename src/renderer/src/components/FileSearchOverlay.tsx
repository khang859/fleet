import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, ArrowDownAZ, Clock, HardDrive, FolderOpen, Layers } from 'lucide-react';
import { Overlay } from './Overlay';
import { createLogger } from '../logger';
const log = createLogger('overlay:file-search');
import {
  useWorkspaceStore,
  getActivePaneContext,
  getPaneContextById
} from '../store/workspace-store';
import { quotePathForShell, bracketedPaste } from '../lib/shell-utils';
import { getFileIcon } from '../lib/file-icons';
import { pathForPaneContext } from '../../../shared/path-platform';
import { z } from 'zod';
import type { FileSearchResult, RecentImageResult } from '../../../shared/ipc-api';

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

// --- Scope types ---

type ScopeId = 'all' | 'files';

const SCOPE_OPTIONS: Array<{ id: ScopeId; label: string; icon: typeof Clock }> = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'files', label: 'Files', icon: FolderOpen }
];

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

// --- Sort options ---

type SortOption = 'date' | 'name' | 'size';

const SORT_OPTIONS: Array<{ id: SortOption; label: string; icon: typeof Clock }> = [
  { id: 'date', label: 'Date', icon: Clock },
  { id: 'name', label: 'Name', icon: ArrowDownAZ },
  { id: 'size', label: 'Size', icon: HardDrive }
];

function sortResults(results: FileSearchResult[], sort: SortOption): FileSearchResult[] {
  const sorted = [...results];
  switch (sort) {
    case 'date':
      return sorted.sort((a, b) => b.modifiedAt - a.modifiedAt);
    case 'name':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'size':
      return sorted.sort((a, b) => b.size - a.size);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [scope, setScope] = useState<ScopeId>('all');
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOption>('date');
  const [recentImages, setRecentImages] = useState<RecentImageResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const targetPaneId = activePaneId;
  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setScope('all');
      setResults(getRecentFiles());
      setSelectedIndex(0);
      setIsLoading(false);
      setError(null);
      void window.fleet.file.searchRecentImages(getActivePaneContext().pathContext).then((res) => {
        if (res.success) setRecentImages(res.results);
      });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search (for All and Files scopes)
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
          scope: undefined,
          limit: 20,
          pathContext: getActivePaneContext().pathContext
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

  // Reset selection when results or scope change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results, scope]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.querySelector(`[data-result-index="${selectedIndex}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const sortedResults = useMemo(() => sortResults(results, sort), [results, sort]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      log.debug('handleSelect', { targetPaneId, filePath: file.path });
      if (!targetPaneId) return;
      const ctx = getPaneContextById(targetPaneId);
      const quoted = quotePathForShell(pathForPaneContext(file.path, ctx), ctx) + ' ';
      window.fleet.pty.input({ paneId: targetPaneId, data: bracketedPaste(quoted) });
      addRecentFile(file);
      onClose();
      // Re-focus the target pane after overlay DOM unmounts
      requestAnimationFrame(() => {
        document.dispatchEvent(
          new CustomEvent('fleet:refocus-pane', { detail: { paneId: targetPaneId } })
        );
      });
    },
    [targetPaneId, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, sortedResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = sortedResults[selectedIndex];
      if (file) handleSelect(file);
    } else if (e.key === 'Tab') {
      // Swallowed so focus never leaves the overlay's input.
      e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const placeholder = scope === 'files' ? 'Search files on disk...' : 'Search files and images...';

  // --- Render helpers ---

  const renderFileResults = (): React.JSX.Element => {
    if (error) {
      return <div className="px-3 py-4 text-sm text-red-400/80 text-center">{error}</div>;
    }

    if (sortedResults.length === 0 && !isLoading) {
      if (query) {
        return (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-fleet-text-muted">No files match &ldquo;{query}&rdquo;</p>
            {scope === 'files' && (
              <button
                onClick={() => setScope('all')}
                className="mt-2 text-xs text-blue-400 hover:text-blue-300"
              >
                Search All instead
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="px-3 py-4 text-sm text-fleet-text-subtle text-center">No recent files</div>
      );
    }

    return (
      <>
        {!query && sortedResults.length > 0 && (
          <div className="px-3 py-1 text-[10px] text-fleet-text-subtle uppercase tracking-wider">
            Recent
          </div>
        )}
        {sortedResults.slice(0, 10).map((file, i) => (
          <button
            key={file.path}
            data-result-index={i}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors active:scale-[0.97] ${
              i === selectedIndex
                ? 'bg-fleet-surface-3 text-fleet-text'
                : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
            }`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => handleSelect(file)}
          >
            <span className="text-fleet-text-subtle shrink-0">{getFileIcon(file.name, 14)}</span>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-medium">
                <HighlightedText text={file.name} query={query} />
              </span>
              <span className="truncate text-xs text-fleet-text-subtle">
                {file.parentDir.replace(window.fleet.homeDir, '~')}
              </span>
            </div>
            <span className="text-[10px] text-fleet-text-subtle shrink-0">
              {sort === 'size' ? formatSize(file.size) : relativeTime(file.modifiedAt)}
            </span>
          </button>
        ))}
      </>
    );
  };

  const renderAllScope = (): React.JSX.Element => {
    return (
      <>
        {/* Recent Images thumbnail strip */}
        {!query && recentImages.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-fleet-text-subtle uppercase tracking-wider">
              Recent Images
            </div>
            <div className="no-scrollbar relative flex gap-2 px-3 py-2 border-b border-fleet-border overflow-x-auto">
              {recentImages.map((img) => (
                <button
                  key={img.path}
                  onClick={() => handleSelect(img)}
                  className="group relative flex flex-col items-center gap-1 p-1.5 rounded hover:bg-fleet-surface-2 transition-colors shrink-0 active:scale-[0.97]"
                  title={img.path}
                >
                  {img.thumbnailDataUrl ? (
                    <img
                      src={img.thumbnailDataUrl}
                      alt={img.name}
                      className="h-[120px] w-[120px] object-cover rounded border border-fleet-border-strong"
                    />
                  ) : (
                    <div className="h-[120px] w-[120px] flex items-center justify-center bg-fleet-surface-2 rounded border border-fleet-border-strong">
                      {getFileIcon(img.name, 24)}
                    </div>
                  )}
                  <span className="text-[10px] text-fleet-text-muted truncate w-[120px] text-center">
                    {img.name}
                  </span>
                  <span className="text-[9px] text-fleet-text-subtle">
                    {relativeTime(img.modifiedAt)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {/* File results */}
        {renderFileResults()}
      </>
    );
  };

  return (
    <Overlay
      open={isOpen}
      onClose={onClose}
      containerClassName="justify-center"
      backdropClassName="bg-fleet-bg/60"
      panelClassName="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl overflow-hidden"
    >
      {/* Search input */}
      <div className="px-3 py-2 border-b border-fleet-border flex items-center gap-2">
        <Search size={14} className="text-fleet-text-subtle shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm text-fleet-text outline-none placeholder-fleet-text-subtle"
        />
        {isLoading && <span className="text-xs text-fleet-text-subtle">Searching...</span>}
      </div>

      {/* Scope tabs */}
      <div className="px-3 py-1.5 border-b border-fleet-border flex items-center gap-1">
        {SCOPE_OPTIONS.map(({ id, label, icon: Icon }) => {
          return (
            <button
              key={id}
              onClick={() => setScope(id)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors active:scale-[0.97] ${
                scope === id
                  ? 'bg-fleet-surface-3 text-fleet-text'
                  : 'text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2'
              }`}
            >
              <Icon size={11} />
              {label}
            </button>
          );
        })}
        {/* Sort controls (only for file-based scopes) */}
        {results.length > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10px] text-fleet-text-subtle mr-1">Sort:</span>
            {SORT_OPTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSort(id)}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors active:scale-[0.97] ${
                  sort === id
                    ? 'bg-fleet-surface-3 text-fleet-text'
                    : 'text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2'
                }`}
              >
                <Icon size={10} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pt-1 pb-2">
        {scope === 'files' && renderFileResults()}
        {scope === 'all' && renderAllScope()}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-fleet-border flex items-center gap-3 text-xs text-fleet-text-subtle">
        {!targetPaneId ? (
          <span className="text-amber-500/80">No active terminal</span>
        ) : (
          <>
            <span>↑↓ navigate</span>
            <span>↵ paste</span>
            <span>esc dismiss</span>
          </>
        )}
      </div>
    </Overlay>
  );
}
