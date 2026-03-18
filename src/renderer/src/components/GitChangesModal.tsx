import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Loader2, GitBranch, AlertCircle } from 'lucide-react';
import { DiffView, DiffModeEnum, DiffFile, type DiffHighlighter } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import type { GitStatusPayload, GitFileStatus } from '../../../shared/ipc-api';

type DiffHighlighterInstance = Omit<DiffHighlighter, 'getHighlighterEngine'> | undefined;

// Lazy-load shiki highlighter
let highlighterPromise: Promise<DiffHighlighterInstance> | null = null;

function useShikiHighlighter() {
  const [highlighter, setHighlighter] = useState<DiffHighlighterInstance>(undefined);
  useEffect(() => {
    if (!highlighterPromise) {
      highlighterPromise = import('@git-diff-view/shiki').then(async (mod) => {
        return await mod.getDiffViewHighlighter();
      });
    }
    highlighterPromise.then(setHighlighter);
  }, []);
  return highlighter;
}

type GitChangesModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
};

export function GitChangesModal({ isOpen, onClose, cwd }: GitChangesModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GitStatusPayload | null>(null);
  const [filterText, setFilterText] = useState('');
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const modalRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);
  const highlighter = useShikiHighlighter();

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
    window.fleet.git.getStatus(cwd).then((result) => {
      setData(result);
      setLoading(false);
    });
  }, [isOpen, cwd]);

  // Filter files
  const filteredFiles = useMemo(() => {
    if (!data?.files) return [];
    if (!filterText) return data.files;
    const lower = filterText.toLowerCase();
    return data.files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [data?.files, filterText]);

  // Parse diff into per-file DiffFile instances
  const diffFiles = useMemo(() => {
    if (!data?.diff) return [];
    return parseDiffToFiles(data.diff, highlighter);
  }, [data?.diff, highlighter]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

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

      if ((e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInputFocused) {
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
        const activeFile = filteredFiles[activeFileIndex];
        if (activeFile) scrollToFile(activeFile.path);
        return;
      }

      if ((e.key === 'n' || e.key === 'p') && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        setActiveFileIndex((prev) => {
          const next = e.key === 'n'
            ? Math.min(prev + 1, filteredFiles.length - 1)
            : Math.max(prev - 1, 0);
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
    [onClose, filteredFiles, activeFileIndex, scrollToFile],
  );

  if (!isOpen) return null;

  if (!cwd) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<AlertCircle size={32} />} message="Working directory not available" onClose={onClose} />
      </ModalShell>
    );
  }

  if (loading) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<Loader2 size={32} className="animate-spin" />} message="Loading changes..." />
      </ModalShell>
    );
  }

  if (data?.error) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<AlertCircle size={32} className="text-red-400" />} message={data.error} onClose={onClose} />
      </ModalShell>
    );
  }

  if (data && !data.isRepo) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<GitBranch size={32} />} message="Not a git repository" onClose={onClose} />
      </ModalShell>
    );
  }

  if (data && data.files.length === 0) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<GitBranch size={32} />} message="No changes" onClose={onClose} />
      </ModalShell>
    );
  }

  const totalInsertions = data?.files.reduce((sum, f) => sum + f.insertions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  return (
    <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <GitBranch size={16} className="text-neutral-400" />
          <span className="text-sm font-medium text-white">{data?.branch || 'Working Changes'}</span>
          <span className="text-xs text-neutral-500">
            {data?.files.length} file{data?.files.length !== 1 ? 's' : ''} changed
            {totalInsertions > 0 && <span className="text-green-400 ml-2">+{totalInsertions}</span>}
            {totalDeletions > 0 && <span className="text-red-400 ml-1">&minus;{totalDeletions}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDiffMode(diffMode === DiffModeEnum.Unified ? DiffModeEnum.Split : DiffModeEnum.Unified)}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            {diffMode === DiffModeEnum.Unified ? 'Split' : 'Unified'}
          </button>
          <button onClick={onClose} className="p-1 text-neutral-500 hover:text-white">
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
              onChange={(e) => { setFilterText(e.target.value); setActiveFileIndex(0); }}
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
                onClick={() => { setActiveFileIndex(i); scrollToFile(file.path); }}
              />
            ))}
          </div>
        </div>

        {/* Diff content */}
        <div ref={diffContainerRef} className="flex-1 min-w-0 overflow-auto">
          {diffFiles.length > 0 ? (
            <DiffContent diffFiles={diffFiles} diffMode={diffMode} highlighter={highlighter} />
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
  children,
  onClose,
  onKeyDown,
  modalRef,
}: {
  children: React.ReactNode;
  onClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  modalRef: React.RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    modalRef.current?.focus();
  }, [modalRef]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl flex flex-col outline-none"
        style={{ width: 'calc(100vw - 64px)', height: 'calc(100vh - 48px)' }}
      >
        {children}
      </div>
    </div>
  );
}

function StateMessage({
  icon,
  message,
  onClose,
}: {
  icon: React.ReactNode;
  message: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-500">
      {icon}
      <span className="text-sm">{message}</span>
      {onClose && (
        <button onClick={onClose} className="text-xs text-neutral-600 hover:text-white mt-2">
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
  renamed: 'text-blue-400',
};

const STATUS_LABELS: Record<GitFileStatus['status'], string> = {
  added: 'A',
  untracked: 'U',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

function FileEntry({
  file,
  active,
  onClick,
}: {
  file: GitFileStatus;
  active: boolean;
  onClick: () => void;
}) {
  const parts = file.path.split('/');
  const filename = parts.pop()!;
  const dir = parts.join('/');

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-800 transition-colors flex items-center gap-2 ${active ? 'bg-neutral-800' : ''}`}
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

// --- Diff parsing and rendering ---

export type ParsedFileDiff = {
  fileName: string;
  hunks: string[];
};

/**
 * Parse a full unified diff string into per-file sections.
 * Each section has the file name and all hunk lines.
 * The library expects each hunk string to start with @@, not contain file-level headers.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = rawDiff.split('\n');
  let currentFile: ParsedFileDiff | null = null;
  let currentHunk: string[] = [];

  for (const line of lines) {
    // New file diff starts with "diff --git"
    if (line.startsWith('diff --git')) {
      // Save previous file
      if (currentFile) {
        if (currentHunk.length > 0) {
          currentFile.hunks.push(currentHunk.join('\n'));
        }
        files.push(currentFile);
      }

      // Extract filename from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      const fileName = match ? match[2] : 'unknown';
      currentFile = { fileName, hunks: [] };
      currentHunk = [];
      continue;
    }

    // Hunk header starts a new hunk
    if (line.startsWith('@@')) {
      if (currentHunk.length > 0 && currentFile) {
        currentFile.hunks.push(currentHunk.join('\n'));
      }
      currentHunk = [line];
      continue;
    }

    // Skip file metadata lines (---, +++, index, etc.) - they're before hunks
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity index') || line.startsWith('rename from') ||
        line.startsWith('rename to') || line.startsWith('Binary files')) {
      continue;
    }

    // Hunk content lines (context, additions, deletions)
    if (currentHunk.length > 0) {
      currentHunk.push(line);
    }
  }

  // Save last file
  if (currentFile) {
    if (currentHunk.length > 0) {
      currentFile.hunks.push(currentHunk.join('\n'));
    }
    files.push(currentFile);
  }

  return files;
}

function getLanguageFromFilename(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    css: 'css',
    scss: 'scss',
    html: 'html',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    toml: 'toml',
    xml: 'xml',
    vue: 'vue',
    svelte: 'svelte',
  };
  return ext ? langMap[ext] : undefined;
}

function parseDiffToFiles(rawDiff: string, highlighter: DiffHighlighterInstance): DiffFile[] {
  const parsed = parseUnifiedDiff(rawDiff);
  const results: DiffFile[] = [];

  for (const fileDiff of parsed) {
    try {
      const lang = getLanguageFromFilename(fileDiff.fileName);
      const diffFile = DiffFile.createInstance({
        newFile: {
          fileName: fileDiff.fileName,
          fileLang: lang ?? null,
          content: null,
        },
        oldFile: {
          fileName: fileDiff.fileName,
          fileLang: lang ?? null,
          content: null,
        },
        hunks: fileDiff.hunks,
      });
      diffFile.initRaw();
      if (highlighter) {
        diffFile.initSyntax({ registerHighlighter: highlighter });
      }
      diffFile.buildSplitDiffLines();
      diffFile.buildUnifiedDiffLines();
      results.push(diffFile);
    } catch (e) {
      console.error('Failed to parse diff for', fileDiff.fileName, e);
    }
  }

  return results;
}

function DiffContent({
  diffFiles,
  diffMode,
  highlighter,
}: {
  diffFiles: DiffFile[];
  diffMode: DiffModeEnum;
  highlighter: DiffHighlighterInstance;
}) {
  if (diffFiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
        No diff content to display
      </div>
    );
  }

  return (
    <div className="p-2">
      {diffFiles.map((file, i) => (
        <div key={file._newFileName || i} className="mb-4" data-file-path={file._newFileName}>
          <div className="sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800 px-3 py-1.5 text-xs font-mono text-neutral-300">
            {file._newFileName}
          </div>
          <DiffView
            diffFile={file}
            diffViewMode={diffMode}
            diffViewTheme="dark"
            diffViewHighlight={!!highlighter}
            registerHighlighter={highlighter}
            diffViewFontSize={13}
          />
        </div>
      ))}
    </div>
  );
}
