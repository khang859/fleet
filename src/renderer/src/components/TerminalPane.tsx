import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import { useTerminalDrop } from '../hooks/use-terminal-drop';
import { PaneToolbar } from './PaneToolbar';
import { SearchBar } from './SearchBar';
import { useCwdStore } from '../store/cwd-store';

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

export function TerminalPane({
  paneId,
  cwd,
  isActive,
  onFocus,
  serializedContent,
  fontFamily,
  fontSize,
  onSplitHorizontal,
  onSplitVertical,
  onClose
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
    paneId,
    cwd,
    serializedContent,
    isActive,
    fontFamily,
    fontSize,
    onScrollStateChange: setIsScrolledUp
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const currentCwd = useCwdStore((s) => s.cwds.get(paneId));
  const gitCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isDragOver, handlers: dragHandlers } = useTerminalDrop(paneId, focus);

  useEffect(() => {
    if (!currentCwd) {
      setIsGitRepo(false);
      return;
    }

    if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    gitCheckTimerRef.current = setTimeout(() => {
      void window.fleet.git.isRepo(currentCwd).then((result) => {
        setIsGitRepo(result.isRepo);
      });
    }, 500);

    return () => {
      if (gitCheckTimerRef.current) clearTimeout(gitCheckTimerRef.current);
    };
  }, [currentCwd]);
  // Listen for search toggle events targeted at this pane
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener('fleet:toggle-search', handler);
    return () => document.removeEventListener('fleet:toggle-search', handler);
  }, [paneId]);

  // Listen for refocus events (e.g. after overlay paste)
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        focus();
      }
    };
    document.addEventListener('fleet:refocus-pane', handler);
    return () => document.removeEventListener('fleet:refocus-pane', handler);
  }, [paneId, focus]);

  return (
    <div
      className={`relative h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0 ${isActive ? 'ring-2 ring-blue-500/70 bg-[#151515]' : 'ring-1 ring-neutral-800/50 bg-[#131313]'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onClick={() => {
        onFocus();
        focus();
      }}
      {...dragHandlers}
    >
      <PaneToolbar
        visible={hovered}
        isGitRepo={isGitRepo}
        onSplitHorizontal={() => onSplitHorizontal?.()}
        onSplitVertical={() => onSplitVertical?.()}
        onClose={() => onClose?.()}
        onSearch={() => setSearchOpen(true)}
        onGitChanges={() => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))}
        onFileSearch={() => document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'))}
        onClipboardHistory={() =>
          document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'))
        }
        onInjectSkills={() => {
          window.fleet.pty.input({
            paneId,
            data: 'Read ~/.fleet/skills/fleet.md to learn the Fleet terminal commands available to you.\n'
          });
        }}
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
            <path
              d="M2 4l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
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
