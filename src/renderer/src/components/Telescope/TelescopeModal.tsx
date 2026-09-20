// src/renderer/src/components/Telescope/TelescopeModal.tsx
import { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';
import { Search } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useWorkspaceStore } from '../../store/workspace-store';
import { createFilesMode } from './modes/files-mode';
import { createGrepMode } from './modes/grep-mode';
import { createBrowseMode } from './modes/browse-mode';
import { createPanesMode } from './modes/panes-mode';
import type { TelescopeMode, TelescopeItem } from './types';
import { ShikiPreview } from './ShikiPreview';
import { Overlay } from '../Overlay';
import { tooltipAnim } from '../../lib/motion';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
  'cur'
]);

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

type TelescopeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
};

const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const modKey = isMac ? '⌘' : 'Ctrl+';

export function TelescopeModal({
  isOpen,
  onClose,
  cwd
}: TelescopeModalProps): React.JSX.Element | null {
  const [activeModeId, setActiveModeId] = useState<string>('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TelescopeItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<{
    base64: string;
    mimeType: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [browseRevision, forceUpdate] = useReducer((n: number) => n + 1, 0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);

  const triggerUpdate = useCallback(() => forceUpdate(), []);

  const modes = useMemo(() => {
    if (!isOpen) return {} as Record<string, TelescopeMode>;
    return {
      files: createFilesMode(cwd, activePaneId),
      grep: createGrepMode(cwd, activePaneId),
      browse: createBrowseMode(cwd, activePaneId, triggerUpdate),
      panes: createPanesMode()
    };
  }, [isOpen, cwd, activePaneId, triggerUpdate]);

  const modeList = useMemo<TelescopeMode[]>(
    () => [modes.files, modes.grep, modes.browse, modes.panes].filter(Boolean),
    [modes]
  );

  const activeMode = modes[activeModeId] as TelescopeMode | undefined;

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setActiveModeId('files');
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setPreviewContent(null);
      setPreviewFilePath(null);
      setPreviewImage(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Search effect
  useEffect(() => {
    if (!isOpen || !activeMode) return;

    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    const delay = activeModeId === 'grep' ? 300 : 50;

    searchDebounceRef.current = setTimeout(() => {
      const result = activeMode.onSearch(query);
      if (result instanceof Promise) {
        void result.then((items) => {
          setResults(items);
          setSelectedIndex(0);
        });
      } else {
        setResults(result);
        setSelectedIndex(0);
      }
    }, delay);

    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [isOpen, query, activeModeId, activeMode, browseRevision]);

  // Preview effect
  useEffect(() => {
    if (!isOpen || results.length === 0) {
      setPreviewContent(null);
      setPreviewFilePath(null);
      setPreviewImage(null);
      return;
    }

    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);

    previewDebounceRef.current = setTimeout(() => {
      const item = results[selectedIndex];
      const data = item.data;

      if (typeof data?.paneId === 'string') {
        const paneType = typeof data.paneType === 'string' ? data.paneType : 'terminal';
        const cwd = typeof data.cwd === 'string' ? data.cwd : '';
        const paneInfo = [
          `Pane: ${item.title}`,
          `Type: ${paneType}`,
          `CWD: ${cwd}`,
          cwd ? `\nDirectory: ${cwd}` : ''
        ]
          .filter(Boolean)
          .join('\n');
        setPreviewImage(null);
        setPreviewFilePath(null);
        setPreviewContent(paneInfo);
        return;
      }

      const filePath = typeof data?.filePath === 'string' ? data.filePath : null;

      if (filePath !== null && data?.isDirectory === true) {
        setPreviewLoading(true);
        setPreviewImage(null);
        setPreviewFilePath(null);
        void window.fleet.file
          .readdir(filePath)
          .then((result) => {
            if (result.success) {
              const listing = result.entries
                .sort((a, b) => {
                  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map((e) => (e.isDirectory ? `${e.name}/` : e.name))
                .join('\n');
              setPreviewContent(listing || '(empty directory)');
            } else {
              setPreviewContent('Could not read directory');
            }
          })
          .finally(() => setPreviewLoading(false));
        return;
      }

      if (filePath !== null && isImageFile(filePath)) {
        setPreviewLoading(true);
        setPreviewContent(null);
        setPreviewFilePath(null);
        void window.fleet.file
          .readBinary(filePath)
          .then((result) => {
            if (result.success && result.data) {
              setPreviewImage({ base64: result.data.base64, mimeType: result.data.mimeType });
            } else {
              setPreviewImage(null);
              setPreviewContent('Could not read image');
            }
          })
          .finally(() => setPreviewLoading(false));
        return;
      }

      if (filePath !== null) {
        setPreviewLoading(true);
        setPreviewImage(null);
        void window.fleet.file
          .read(filePath)
          .then((result) => {
            if (result.success) {
              const lines = result.data.content.split('\n').slice(0, 200);
              setPreviewContent(lines.join('\n'));
              setPreviewFilePath(filePath);
            } else {
              setPreviewContent('Could not read file');
              setPreviewFilePath(null);
            }
          })
          .finally(() => setPreviewLoading(false));
        return;
      }

      setPreviewImage(null);
      setPreviewFilePath(null);
      setPreviewContent('No preview available');
    }, 100);

    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  }, [isOpen, results, selectedIndex]);

  // Scroll selected into view
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-result-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + 1-4: switch mode
      if (cmdOrCtrl && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < modeList.length) {
          setActiveModeId(modeList[idx].id);
          setQuery('');
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (selectedIndex < results.length && activeMode?.onAltSelect) {
          activeMode.onAltSelect(results[selectedIndex]);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex >= results.length || !activeMode) return;
        const item = results[selectedIndex];
        const isDirectory = item.data?.isDirectory;
        if (activeModeId === 'browse' && isDirectory === true) {
          // navigate into directory — don't close
          activeMode.onSelect(item);
          setQuery('');
          setSelectedIndex(0);
        } else {
          activeMode.onSelect(item);
          onClose();
        }
      } else if (e.key === 'Backspace' && query === '' && activeModeId === 'browse') {
        e.preventDefault();
        activeMode?.onNavigateUp?.();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [results, selectedIndex, activeMode, activeModeId, query, modeList, onClose]
  );

  const browseBreadcrumbs = activeModeId === 'browse' && activeMode?.breadcrumbs;

  const renderBreadcrumbs = (): React.JSX.Element | null => {
    if (!browseBreadcrumbs || browseBreadcrumbs.length === 0) return null;

    // Reconstruct full paths for each crumb
    const homeDir = window.fleet.homeDir;

    return (
      <div className="px-3 py-1.5 border-b border-fleet-border flex items-center gap-1 text-xs text-fleet-text-muted overflow-x-auto min-w-0">
        {browseBreadcrumbs.map((segment, i) => {
          const isLast = i === browseBreadcrumbs.length - 1;
          // Build the absolute path for this crumb
          const pathUpToSegment = browseBreadcrumbs
            .slice(0, i + 1)
            .join('/')
            .replace(/^~/, homeDir);

          return (
            <span key={i} className="flex items-center gap-1 shrink-0">
              {i > 0 && <span className="text-fleet-text-subtle">/</span>}
              <button
                onClick={() => {
                  if (!isLast && activeMode.onNavigate) {
                    activeMode.onNavigate(pathUpToSegment);
                  }
                }}
                className={
                  isLast
                    ? 'text-fleet-text-secondary cursor-default transition active:scale-[0.97]'
                    : 'text-fleet-text-muted hover:text-fleet-text-secondary transition-colors active:scale-[0.97]'
                }
              >
                {segment}
              </button>
            </span>
          );
        })}
      </div>
    );
  };

  const renderPreviewPanel = (): React.JSX.Element => {
    if (previewLoading) {
      return <div className="text-xs text-fleet-text-subtle p-3">Loading preview...</div>;
    }

    if (previewImage) {
      return (
        <div className="flex items-center justify-center h-full">
          <img
            src={`data:${previewImage.mimeType};base64,${previewImage.base64}`}
            className="max-w-full max-h-full object-contain"
            alt="Preview"
          />
        </div>
      );
    }

    if (!previewContent) {
      return (
        <div className="text-xs text-fleet-text-subtle p-3 italic">Select an item to preview</div>
      );
    }

    if (previewFilePath) {
      return <ShikiPreview content={previewContent} filePath={previewFilePath} />;
    }

    return (
      <pre className="text-[11px] text-fleet-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-all">
        {previewContent}
      </pre>
    );
  };

  return (
    <Overlay
      open={isOpen}
      onClose={onClose}
      containerClassName="justify-center"
      panelClassName="mt-[10vh] w-[800px] h-[70vh] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl overflow-hidden self-start"
    >
      {/* Header: search input + mode tabs */}
      <div className="flex items-center border-b border-fleet-border-strong">
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0">
          <Search size={14} className="text-fleet-text-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeMode?.placeholder ?? 'Search...'}
            className="flex-1 bg-transparent text-sm text-fleet-text outline-none placeholder-fleet-text-subtle min-w-0"
          />
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-l border-fleet-border-strong shrink-0">
          <Tooltip.Provider delayDuration={500}>
            {modeList.map((mode, i) => {
              const Icon = mode.icon;
              const shortcut = `${modKey}${i + 1}`;
              const isActive = mode.id === activeModeId;
              return (
                <Tooltip.Root key={mode.id}>
                  <Tooltip.Trigger asChild>
                    <button
                      onClick={() => {
                        setActiveModeId(mode.id);
                        setQuery('');
                        inputRef.current?.focus();
                      }}
                      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors active:scale-[0.97] ${
                        isActive
                          ? 'bg-fleet-surface-3 text-fleet-text-secondary'
                          : 'text-fleet-text-subtle hover:text-fleet-text-secondary hover:bg-fleet-surface-2'
                      }`}
                    >
                      <Icon size={12} />
                      {mode.label}
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="bottom"
                      className={`z-50 rounded bg-fleet-surface-2 border border-fleet-border-strong px-2 py-1 text-[11px] text-fleet-text-secondary shadow-md ${tooltipAnim}`}
                      sideOffset={4}
                    >
                      {shortcut}
                      <Tooltip.Arrow className="fill-fleet-surface-2" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              );
            })}
          </Tooltip.Provider>
        </div>
      </div>

      {/* Breadcrumbs (browse mode only) */}
      {renderBreadcrumbs()}

      {/* Body */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
        {/* Results column */}
        <div ref={listRef} className="w-[40%] overflow-y-auto border-r border-fleet-border py-1">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-xs text-fleet-text-subtle text-center italic">
              {query ? 'No results' : 'Type to search'}
            </div>
          ) : (
            results.map((item, i) => {
              const isSelected = i === selectedIndex;
              return (
                <button
                  key={item.id}
                  data-result-index={i}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors active:scale-[0.97] ${
                    isSelected
                      ? 'bg-fleet-surface-3 text-fleet-text'
                      : item.data?.isIgnored
                        ? 'text-fleet-text-subtle hover:bg-fleet-surface-2'
                        : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
                  }`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => {
                    if (!activeMode) return;
                    const isDirectory = item.data?.isDirectory;
                    if (activeModeId === 'browse' && isDirectory === true) {
                      activeMode.onSelect(item);
                      setQuery('');
                      setSelectedIndex(0);
                    } else {
                      activeMode.onSelect(item);
                      onClose();
                    }
                  }}
                >
                  <span className="text-fleet-text-subtle shrink-0 flex items-center">
                    {item.icon}
                  </span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate text-sm font-medium">{item.title}</span>
                    {item.subtitle && (
                      <span className="truncate text-xs text-fleet-text-subtle">
                        {item.subtitle}
                      </span>
                    )}
                  </div>
                  {item.meta && (
                    <span className="text-[10px] text-fleet-text-subtle shrink-0">{item.meta}</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Preview column */}
        <div className="w-[60%] overflow-auto p-3">{renderPreviewPanel()}</div>
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-fleet-border flex items-center gap-3 text-xs text-fleet-text-subtle">
        <span>↑↓ navigate</span>
        <span>↵ open/focus</span>
        {activeModeId !== 'panes' && <span>⇧↵ paste path</span>}
        {activeModeId === 'browse' && <span>⌫ up dir</span>}
        <span>esc dismiss</span>
      </div>
    </Overlay>
  );
}
