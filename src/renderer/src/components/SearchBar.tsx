import { useState, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

type SearchBarProps = {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string) => void;
  onSearchPrevious: (query: string) => void;
};

export function SearchBar({
  isOpen,
  onClose,
  onSearch,
  onSearchPrevious
}: SearchBarProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="absolute top-10 right-0 z-30 m-2 flex items-center gap-1 bg-fleet-surface-2 border border-fleet-border rounded-md px-2 py-1 shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.shiftKey) {
              onSearchPrevious(query);
            } else {
              onSearch(query);
            }
          }
          if (e.key === 'Escape') {
            onClose();
          }
        }}
        placeholder="Search..."
        className="bg-transparent text-sm text-fleet-text outline-none w-48 placeholder-fleet-text-subtle"
      />
      <button
        onClick={() => onSearchPrevious(query)}
        className="p-0.5 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-3 transition-colors active:scale-90"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => onSearch(query)}
        className="p-0.5 text-fleet-text-muted hover:text-fleet-text rounded hover:bg-fleet-surface-3 transition-colors active:scale-90"
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button
        onClick={onClose}
        className="text-fleet-text-subtle hover:text-fleet-text text-sm ml-1 transition active:scale-90"
      >
        &times;
      </button>
    </div>
  );
}
