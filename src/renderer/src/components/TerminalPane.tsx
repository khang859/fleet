import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import { PaneToolbar } from './PaneToolbar';
import { SearchBar } from './SearchBar';

function quotePathForShell(filePath: string, platform: string): string {
  if (platform === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''" ) + "'";
}

function formatDroppedFiles(files: FileList, platform: string): string {
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const filePath = window.fleet.utils.getFilePath(files[i]);
    paths.push(quotePathForShell(filePath, platform));
  }
  return paths.join(' ') + ' ';
}

type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
  serializedContent?: string;
  fontFamily?: string;
  fontSize?: number;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
};

export function TerminalPane({ paneId, cwd, isActive, onFocus, serializedContent, fontFamily, fontSize, onSplitHorizontal, onSplitVertical, onClose }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const { fit, focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, { paneId, cwd, serializedContent, isActive, fontFamily, fontSize, onScrollStateChange: setIsScrolledUp });
  const [searchOpen, setSearchOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Listen for search toggle events targeted at this pane
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.paneId === paneId) {
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener('fleet:toggle-search', handler);
    return () => document.removeEventListener('fleet:toggle-search', handler);
  }, [paneId]);

  // Safety net: reset drag state on document-level drop/dragend to prevent stuck overlay
  useEffect(() => {
    const resetDrag = () => {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener('drop', resetDrag);
    document.addEventListener('dragend', resetDrag);
    return () => {
      document.removeEventListener('drop', resetDrag);
      document.removeEventListener('dragend', resetDrag);
    };
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    // Only show overlay for file drags, not text/URL drags
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (e.dataTransfer.files.length > 0) {
      const formatted = formatDroppedFiles(e.dataTransfer.files, window.fleet.platform);
      window.fleet.pty.input({ paneId, data: formatted });
      focus();
    }
  };

  return (
    <div
      className={`relative h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0 ${isActive ? 'ring-2 ring-blue-500/70 bg-[#151515]' : 'ring-1 ring-neutral-800/50 bg-[#131313]'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onClick={() => {
        onFocus();
        focus();
        fit();
      }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneToolbar
        visible={hovered}
        onSplitHorizontal={() => onSplitHorizontal?.()}
        onSplitVertical={() => onSplitVertical?.()}
        onClose={() => onClose?.()}
        onSearch={() => setSearchOpen(true)}
      />
      <SearchBar
        isOpen={searchOpen}
        onClose={() => {
          setSearchOpen(false);
          clearSearch();
          focus();
        }}
        onSearch={(q) => search(q)}
        onSearchPrevious={(q) => searchPrevious(q)}
      />
      <div ref={containerRef} className="h-full w-full" />
      {isScrolledUp && (
        <button
          className="absolute bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-md bg-neutral-800/90 px-2.5 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur-sm hover:bg-neutral-700 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            scrollToBottom();
            focus();
          }}
          tabIndex={-1}
          aria-label="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Bottom</span>
        </button>
      )}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-400 rounded pointer-events-none">
          <span className="text-blue-300 text-sm font-medium">Drop to paste file path</span>
        </div>
      )}
    </div>
  );
}
