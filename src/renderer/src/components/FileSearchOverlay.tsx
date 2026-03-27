import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, ArrowDownAZ, Clock, HardDrive, Image, FolderOpen, Layers } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspace-store';
import { useStarCommandStore } from '../store/star-command-store';
import { useImageStore } from '../store/image-store';
import { quotePathForShell, bracketedPaste } from '../lib/shell-utils';
import { getFileIcon } from '../lib/file-icons';
import { z } from 'zod';
import type { FileSearchResult, RecentImageResult } from '../../../shared/ipc-api';
import type { ImageGenerationMeta } from '../../../shared/types';

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

type ScopeId = 'all' | 'files' | 'generated';

const SCOPE_OPTIONS: Array<{ id: ScopeId; label: string; icon: typeof Clock }> = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'generated', label: 'Generated', icon: Image }
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

// --- Time group helpers ---

type TimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'Older';

function getTimeGroup(epochMs: number): TimeGroup {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - now.getDay() * 86400000;

  if (epochMs >= startOfToday) return 'Today';
  if (epochMs >= startOfYesterday) return 'Yesterday';
  if (epochMs >= startOfWeek) return 'This Week';
  return 'Older';
}

function groupByTime<T>(items: T[], getTime: (item: T) => number): Array<{ group: TimeGroup; items: T[] }> {
  const groups = new Map<TimeGroup, T[]>();
  const order: TimeGroup[] = ['Today', 'Yesterday', 'This Week', 'Older'];
  for (const g of order) groups.set(g, []);

  for (const item of items) {
    const group = getTimeGroup(getTime(item));
    groups.get(group)!.push(item);
  }

  return order.filter((g) => groups.get(g)!.length > 0).map((g) => ({ group: g, items: groups.get(g)! }));
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

// --- Generated image thumbnail ---

function GeneratedThumbnail({
  generation,
  onSelect,
  size = 'small'
}: {
  generation: ImageGenerationMeta;
  onSelect: (file: FileSearchResult) => void;
  size?: 'small' | 'large';
}): React.JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null);
  const firstImage = generation.images.find((img) => img.filename);

  useEffect(() => {
    if (!firstImage?.filename) return;
    const filePath = `${window.fleet.homeDir}/.fleet/images/generations/${generation.id}/${firstImage.filename}`;
    void window.fleet.file.readBinary(filePath).then((result) => {
      if (result.success && result.data) {
        setSrc(`data:${result.data.mimeType};base64,${result.data.base64}`);
      }
    });
  }, [generation.id, firstImage?.filename]);

  if (!firstImage?.filename) return null;

  const filePath = `${window.fleet.homeDir}/.fleet/images/generations/${generation.id}/${firstImage.filename}`;
  const parentDir = `${window.fleet.homeDir}/.fleet/images/generations/${generation.id}`;
  const isLarge = size === 'large';
  const imgClass = isLarge
    ? 'h-[150px] w-[150px] object-cover rounded border border-neutral-700'
    : 'h-[120px] w-[120px] object-cover rounded border border-neutral-700';
  const placeholderClass = isLarge
    ? 'h-[150px] w-[150px] flex items-center justify-center bg-neutral-800 rounded border border-neutral-700 text-neutral-600'
    : 'h-[120px] w-[120px] flex items-center justify-center bg-neutral-800 rounded border border-neutral-700 text-neutral-600';
  const labelWidth = isLarge ? 'w-[150px]' : 'w-[120px]';

  return (
    <button
      onClick={() =>
        onSelect({
          path: filePath,
          name: firstImage.filename!,
          parentDir,
          modifiedAt: new Date(generation.createdAt).getTime(),
          size: 0
        })
      }
      className="group relative flex flex-col items-center gap-1 p-1.5 rounded hover:bg-neutral-800 transition-colors shrink-0"
      title={generation.prompt}
    >
      {src ? (
        <img src={src} alt={generation.prompt} className={imgClass} />
      ) : (
        <div className={placeholderClass}>
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
      )}
      <span className={`text-[10px] text-neutral-400 truncate ${labelWidth} text-center`}>
        {generation.prompt.length > 20 ? generation.prompt.slice(0, 20) + '…' : generation.prompt}
      </span>
      <span className="text-[9px] text-neutral-600">
        {relativeTime(new Date(generation.createdAt).getTime())}
      </span>
    </button>
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
  const admiralPaneId = useStarCommandStore((s) => s.admiralPaneId);
  const targetPaneId = activePaneId ?? admiralPaneId;
  const generations = useImageStore((s) => s.generations);
  const loadGenerations = useImageStore((s) => s.loadGenerations);

  const completedGenerations = useMemo(
    () =>
      generations
        .filter((g) => g.status === 'completed' || g.status === 'partial')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [generations]
  );

  const recentGenerations = useMemo(() => completedGenerations.slice(0, 5), [completedGenerations]);

  const allGeneratedFiles = useMemo(
    () =>
      completedGenerations.flatMap((g) =>
        g.images
          .filter((img) => img.filename)
          .map((img) => ({
            path: `${window.fleet.homeDir}/.fleet/images/generations/${g.id}/${img.filename}`,
            name: img.filename!,
            parentDir: `${window.fleet.homeDir}/.fleet/images/generations/${g.id}`,
            modifiedAt: new Date(g.createdAt).getTime(),
            size: 0
          }))
      ),
    [completedGenerations]
  );

  // Result counts for scope tabs
  const fileResultCount = useMemo(() => {
    if (!query.trim()) return getRecentFiles().length;
    return results.length;
  }, [query, results]);

  const generatedResultCount = useMemo(() => {
    if (!query.trim()) return allGeneratedFiles.length;
    const q = query.trim().toLowerCase();
    return allGeneratedFiles.filter((f) => f.name.toLowerCase().includes(q)).length;
  }, [query, allGeneratedFiles]);

  // Time-grouped generations for the Generated scope
  const groupedGenerations = useMemo(
    () => groupByTime(completedGenerations, (g) => new Date(g.createdAt).getTime()),
    [completedGenerations]
  );

  // Filtered generations when searching in Generated scope
  const filteredGenerations = useMemo(() => {
    if (!query.trim()) return completedGenerations;
    const q = query.trim().toLowerCase();
    return completedGenerations.filter(
      (g) =>
        g.prompt.toLowerCase().includes(q) ||
        g.images.some((img) => img.filename?.toLowerCase().includes(q))
    );
  }, [query, completedGenerations]);

  const filteredGroupedGenerations = useMemo(
    () => groupByTime(filteredGenerations, (g) => new Date(g.createdAt).getTime()),
    [filteredGenerations]
  );

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setScope('all');
      setResults(getRecentFiles());
      setSelectedIndex(0);
      setIsLoading(false);
      setError(null);
      void window.fleet.file.searchRecentImages().then((res) => {
        if (res.success) setRecentImages(res.results);
      });
      void loadGenerations();
      // Blur active element first to release xterm's hidden textarea
      // which otherwise captures keyboard events (including paste)
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search (for All and Files scopes)
  useEffect(() => {
    if (!isOpen || scope === 'generated') return;

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

  // Reset selection when results or scope change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results, scope]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const sortedResults = useMemo(() => sortResults(results, sort), [results, sort]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      if (!targetPaneId) return;
      const quoted = quotePathForShell(file.path, window.fleet.platform) + ' ';
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

  const handleScopeToParent = useCallback(() => {
    const file = sortedResults[selectedIndex];
    if (file) {
      // In generated scope, Tab doesn't make sense for scoping to parent
      if (scope !== 'generated') {
        // For file results, we can't set a folder scope with the new tab model,
        // but we preserve the keyboard shortcut for power users
      }
    }
  }, [sortedResults, selectedIndex, scope]);

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
      e.preventDefault();
      handleScopeToParent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  const placeholder =
    scope === 'generated'
      ? 'Search generated images...'
      : scope === 'files'
        ? 'Search files on disk...'
        : 'Search files and images...';

  // --- Render helpers ---

  const renderGeneratedGrid = (gens: ImageGenerationMeta[]): React.JSX.Element => (
    <div className="grid grid-cols-3 gap-2 px-3 py-2">
      {gens.map((gen) => (
        <GeneratedThumbnail key={gen.id} generation={gen} onSelect={handleSelect} size="large" />
      ))}
    </div>
  );

  const renderGeneratedScope = (): React.JSX.Element => {
    if (query.trim()) {
      // Searching — show filtered results grouped by time
      if (filteredGenerations.length === 0) {
        return (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-neutral-400">
              No generated images match &ldquo;{query}&rdquo;
            </p>
            <button
              onClick={() => setScope('all')}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300"
            >
              Search All instead
            </button>
          </div>
        );
      }
      return (
        <>
          {filteredGroupedGenerations.map(({ group, items }) => (
            <div key={group}>
              <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
                {group}
              </div>
              {renderGeneratedGrid(items)}
            </div>
          ))}
        </>
      );
    }

    // No query — show recent strip + all grouped by time
    if (completedGenerations.length === 0) {
      return (
        <div className="px-3 py-8 text-center">
          <div className="text-neutral-600 mb-2">
            <Image size={24} className="mx-auto" />
          </div>
          <p className="text-sm text-neutral-400">No generated images yet</p>
          <p className="text-xs text-neutral-600 mt-1">
            Generate one with: <code className="text-neutral-500">fleet images generate --prompt &quot;...&quot;</code>
          </p>
        </div>
      );
    }

    return (
      <>
        {groupedGenerations.map(({ group, items }) => (
          <div key={group}>
            <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
              {group}
            </div>
            {renderGeneratedGrid(items)}
          </div>
        ))}
      </>
    );
  };

  const renderFileResults = (): React.JSX.Element => {
    if (error) {
      return <div className="px-3 py-4 text-sm text-red-400/80 text-center">{error}</div>;
    }

    if (sortedResults.length === 0 && !isLoading) {
      if (query) {
        return (
          <div className="px-3 py-8 text-center">
            <p className="text-sm text-neutral-400">No files match &ldquo;{query}&rdquo;</p>
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
        <div className="px-3 py-4 text-sm text-neutral-500 text-center">No recent files</div>
      );
    }

    return (
      <>
        {!query && sortedResults.length > 0 && (
          <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
            Recent
          </div>
        )}
        {sortedResults.slice(0, 10).map((file, i) => (
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
        {/* Generated Images thumbnail strip (only when no query) */}
        {!query && recentGenerations.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider flex items-center justify-between">
              <span>Generated Images</span>
              {completedGenerations.length > 5 && (
                <button
                  onClick={() => setScope('generated')}
                  className="text-blue-400 hover:text-blue-300 normal-case tracking-normal"
                >
                  See all {completedGenerations.length} →
                </button>
              )}
            </div>
            <div className="relative flex gap-2 px-3 py-2 border-b border-neutral-800 overflow-x-auto">
              {recentGenerations.map((gen) => (
                <GeneratedThumbnail key={gen.id} generation={gen} onSelect={handleSelect} />
              ))}
            </div>
          </>
        )}
        {/* Recent Images thumbnail strip */}
        {!query && recentImages.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
              Recent Images
            </div>
            <div className="relative flex gap-2 px-3 py-2 border-b border-neutral-800 overflow-x-auto">
              {recentImages.map((img) => (
                <button
                  key={img.path}
                  onClick={() => handleSelect(img)}
                  className="group relative flex flex-col items-center gap-1 p-1.5 rounded hover:bg-neutral-800 transition-colors shrink-0"
                  title={img.path}
                >
                  {img.thumbnailDataUrl ? (
                    <img
                      src={img.thumbnailDataUrl}
                      alt={img.name}
                      className="h-[120px] w-[120px] object-cover rounded border border-neutral-700"
                    />
                  ) : (
                    <div className="h-[120px] w-[120px] flex items-center justify-center bg-neutral-800 rounded border border-neutral-700">
                      {getFileIcon(img.name, 24)}
                    </div>
                  )}
                  <span className="text-[10px] text-neutral-400 truncate w-[120px] text-center">
                    {img.name}
                  </span>
                  <span className="text-[9px] text-neutral-600">
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
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Search size={14} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          {isLoading && <span className="text-xs text-neutral-500">Searching...</span>}
        </div>

        {/* Scope tabs */}
        <div className="px-3 py-1.5 border-b border-neutral-800 flex items-center gap-1">
          {SCOPE_OPTIONS.map(({ id, label, icon: Icon }) => {
            const count =
              id === 'generated'
                ? generatedResultCount
                : id === 'files'
                  ? fileResultCount
                  : undefined;
            return (
              <button
                key={id}
                onClick={() => setScope(id)}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                  scope === id
                    ? 'bg-neutral-700 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                <Icon size={11} />
                {label}
                {count !== undefined && count > 0 && (
                  <span className="text-[10px] text-neutral-500 ml-0.5">({count})</span>
                )}
              </button>
            );
          })}
          {/* Sort controls (only for file-based scopes) */}
          {scope !== 'generated' && results.length > 0 && (
            <div className="ml-auto flex items-center gap-1">
              <span className="text-[10px] text-neutral-600 mr-1">Sort:</span>
              {SORT_OPTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setSort(id)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    sort === id
                      ? 'bg-neutral-700 text-neutral-200'
                      : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
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
        <div ref={listRef} className="overflow-y-auto py-1">
          {scope === 'generated' && renderGeneratedScope()}
          {scope === 'files' && renderFileResults()}
          {scope === 'all' && renderAllScope()}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
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
      </div>
    </div>
  );
}
