import { Suspense, lazy, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Loader2, GitBranch, AlertCircle } from 'lucide-react';
import type { GitStatusPayload, GitFileStatus } from '../../../shared/ipc-api';
import type { PathContext } from '../../../shared/shell-profiles';
import { Overlay } from './Overlay';
import type { DiffViewMode } from './git-diff/DiffContent';

// `@git-diff-view` and its shiki highlighter are the heaviest thing this modal
// draws, and the modal stays mounted for the whole session. Overlay renders
// nothing while closed, so this import fires on first open rather than at
// startup. See the module for why the parent stays free of DiffModeEnum.
const DiffContent = lazy(async () => ({
  default: (await import('./git-diff/DiffContent')).DiffContent
}));

type GitChangesModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
  /** When set, show committed changes against this ref (base...HEAD) instead of the working tree. */
  compareRef?: string | null;
  /** Pane coordinate system for `cwd`; WSL panes run git inside the distro. */
  pathContext?: PathContext;
};

export function GitChangesModal({
  isOpen,
  onClose,
  cwd,
  compareRef,
  pathContext
}: GitChangesModalProps): React.JSX.Element | null {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GitStatusPayload | null>(null);
  const [filterText, setFilterText] = useState('');
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffViewMode>('unified');
  const modalRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);

  // Scroll diff pane to a specific file's section
  const scrollToFile = useCallback((filePath: string | undefined) => {
    if (!filePath || !diffContainerRef.current) return;
    const el = diffContainerRef.current.querySelector(`[data-file-path="${CSS.escape(filePath)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Fetch git status when modal opens
  useEffect(() => {
    if (!isOpen || !cwd) return;
    setLoading(true);
    setData(null);
    setFilterText('');
    setActiveFileIndex(0);
    window.fleet.git
      .getStatus(cwd, compareRef ?? undefined, pathContext)
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch git status:', err);
        setData({ isRepo: true, branch: '', files: [], diff: '', error: String(err) });
        setLoading(false);
      });
  }, [isOpen, cwd, compareRef, pathContext]);

  // Filter files
  const filteredFiles = useMemo(() => {
    if (!data?.files) return [];
    if (!filterText) return data.files;
    const lower = filterText.toLowerCase();
    return data.files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [data?.files, filterText]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target;
      const isInputFocused =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'q' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        filterInputRef.current?.focus();
        return;
      }

      if (
        (e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        !isInputFocused
      ) {
        e.preventDefault();
        e.stopPropagation();
        const down = e.key === 'j' || e.key === 'ArrowDown';
        setActiveFileIndex((prev) => {
          const next = down ? Math.min(prev + 1, filteredFiles.length - 1) : Math.max(prev - 1, 0);
          scrollToFile(filteredFiles[next]?.path);
          return next;
        });
        return;
      }

      if (e.key === 'Enter' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        const activeFile = filteredFiles.at(activeFileIndex);
        if (activeFile) scrollToFile(activeFile.path);
        return;
      }

      if ((e.key === 'n' || e.key === 'p') && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        setActiveFileIndex((prev) => {
          const next =
            e.key === 'n' ? Math.min(prev + 1, filteredFiles.length - 1) : Math.max(prev - 1, 0);
          scrollToFile(filteredFiles[next]?.path);
          return next;
        });
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.stopPropagation();
        filterInputRef.current?.focus();
        return;
      }
    },
    [onClose, filteredFiles, activeFileIndex, scrollToFile]
  );

  if (!cwd) {
    return (
      <ModalShell open={isOpen} onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage
          icon={<AlertCircle size={32} />}
          message="Working directory not available"
          onClose={onClose}
        />
      </ModalShell>
    );
  }

  if (loading) {
    return (
      <ModalShell open={isOpen} onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage
          icon={<Loader2 size={32} className="animate-spin" />}
          message="Loading changes..."
        />
      </ModalShell>
    );
  }

  if (data?.error) {
    return (
      <ModalShell open={isOpen} onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage
          icon={<AlertCircle size={32} className="text-red-400" />}
          message={data.error}
          onClose={onClose}
        />
      </ModalShell>
    );
  }

  if (data && !data.isRepo) {
    return (
      <ModalShell open={isOpen} onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage
          icon={<GitBranch size={32} />}
          message="Not a git repository"
          onClose={onClose}
        />
      </ModalShell>
    );
  }

  if (data?.files.length === 0) {
    return (
      <ModalShell open={isOpen} onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<GitBranch size={32} />} message="No changes" onClose={onClose} />
      </ModalShell>
    );
  }

  const totalInsertions = data?.files.reduce((sum, f) => sum + f.insertions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      onKeyDown={handleKeyDown}
      modalRef={modalRef}
      showCloseButton={false}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <GitBranch size={16} className="text-neutral-400" />
          <span className="text-sm font-medium text-white">
            {data?.branch || 'Working Changes'}
          </span>
          <span className="text-xs text-neutral-500">
            {data?.files.length} file{data?.files.length !== 1 ? 's' : ''} changed
            {totalInsertions > 0 && <span className="text-green-400 ml-2">+{totalInsertions}</span>}
            {totalDeletions > 0 && (
              <span className="text-red-400 ml-1">&minus;{totalDeletions}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDiffMode(diffMode === 'unified' ? 'split' : 'unified')}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition active:scale-[0.97]"
          >
            {diffMode === 'unified' ? 'Split' : 'Unified'}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-white transition active:scale-90"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body: sidebar + diff */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* File list sidebar */}
        <div className="w-60 border-r border-neutral-800 flex flex-col shrink-0">
          <div className="p-2 border-b border-neutral-800">
            <input
              ref={filterInputRef}
              type="text"
              placeholder="Filter files..."
              value={filterText}
              onChange={(e) => {
                setFilterText(e.target.value);
                setActiveFileIndex(0);
              }}
              className="w-full px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-500 outline-none focus:border-neutral-600"
            />
            {filterText && (
              <span className="text-[10px] text-neutral-500 mt-1 block">
                {filteredFiles.length} of {data?.files.length} files
              </span>
            )}
          </div>
          <div ref={fileListRef} className="flex-1 overflow-y-auto">
            {filteredFiles.map((file, i) => (
              <FileEntry
                key={file.path}
                file={file}
                active={i === activeFileIndex}
                onClick={() => {
                  setActiveFileIndex(i);
                  scrollToFile(file.path);
                }}
              />
            ))}
          </div>
        </div>

        {/* Diff content */}
        <div ref={diffContainerRef} className="flex-1 min-w-0 overflow-auto">
          {data?.diff ? (
            <Suspense fallback={null}>
              <DiffContent rawDiff={data.diff} mode={diffMode} />
            </Suspense>
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
              No diff content
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// --- Sub-components ---

function ModalShell({
  open,
  children,
  onClose,
  onKeyDown,
  modalRef,
  showCloseButton = true
}: {
  open: boolean;
  children: React.ReactNode;
  onClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  modalRef: React.RefObject<HTMLDivElement | null>;
  showCloseButton?: boolean;
}): React.JSX.Element {
  useEffect(() => {
    if (open) modalRef.current?.focus();
  }, [open, modalRef]);

  return (
    <Overlay open={open} onClose={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl flex flex-col outline-none"
        style={{ width: 'calc(100vw - 64px)', height: 'calc(100vh - 48px)' }}
      >
        {showCloseButton && (
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 p-1 text-neutral-500 hover:text-white transition active:scale-90"
          >
            <X size={16} />
          </button>
        )}
        {children}
      </div>
    </Overlay>
  );
}

function StateMessage({
  icon,
  message,
  onClose
}: {
  icon: React.ReactNode;
  message: string;
  onClose?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-500">
      {icon}
      <span className="text-sm">{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          className="text-xs text-neutral-600 hover:text-white mt-2 transition active:scale-[0.97]"
        >
          Close
        </button>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<GitFileStatus['status'], string> = {
  added: 'text-green-400',
  untracked: 'text-green-400',
  modified: 'text-yellow-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400'
};

const STATUS_LABELS: Record<GitFileStatus['status'], string> = {
  added: 'A',
  untracked: 'U',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
};

function FileEntry({
  file,
  active,
  onClick
}: {
  file: GitFileStatus;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const parts = file.path.split('/');
  // `split` always yields at least one element, so this only falls back if `path` is empty.
  const filename = parts.pop() ?? file.path;
  const dir = parts.join('/');

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-800 transition-colors active:scale-[0.97] flex items-center gap-2 ${active ? 'bg-neutral-800' : ''}`}
    >
      <span className={`font-mono text-[10px] ${STATUS_COLORS[file.status]}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-white truncate">{filename}</div>
        {dir && <div className="text-neutral-500 truncate">{dir}</div>}
      </div>
      <span className="text-[10px] text-neutral-500 shrink-0">
        {file.insertions > 0 && <span className="text-green-400">+{file.insertions}</span>}
        {file.deletions > 0 && <span className="text-red-400 ml-1">&minus;{file.deletions}</span>}
      </span>
    </button>
  );
}
