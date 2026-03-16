import { useRef, useState, useEffect } from 'react';
import { useTerminal } from '../hooks/use-terminal';
import { PaneToolbar } from './PaneToolbar';
import { SearchBar } from './SearchBar';

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
  const { fit, focus, search, searchPrevious, clearSearch } = useTerminal(containerRef, { paneId, cwd, serializedContent, isActive, fontFamily, fontSize });
  const [searchOpen, setSearchOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

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
    </div>
  );
}
