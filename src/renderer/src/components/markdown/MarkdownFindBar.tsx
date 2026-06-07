import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

type MarkdownFindBarProps = {
  isOpen: boolean;
  query: string;
  matchCount: number;
  /** 0-based index of the active match, or -1 when there are none. */
  currentIndex: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

/**
 * Find bar for the markdown preview. Purely presentational — all match state lives
 * in `useMarkdownFind`. Mirrors the terminal SearchBar's look, with an added match
 * counter.
 */
export function MarkdownFindBar({
  isOpen,
  query,
  matchCount,
  currentIndex,
  onQueryChange,
  onNext,
  onPrev,
  onClose
}: MarkdownFindBarProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const counter = query
    ? matchCount === 0
      ? 'No results'
      : `${currentIndex + 1}/${matchCount}`
    : '';

  return (
    <div className="absolute top-2 right-2 z-30 flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in document…"
        className="w-48 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
      />
      {counter && (
        <span className="shrink-0 select-none text-xs tabular-nums text-neutral-500">
          {counter}
        </span>
      )}
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="ml-1 rounded p-0.5 text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-white active:scale-90"
        title="Close (Esc)"
      >
        <X size={14} />
      </button>
    </div>
  );
}
