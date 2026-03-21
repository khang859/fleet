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
    <div className="absolute top-0 right-0 z-10 m-2 flex items-center gap-1 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1 shadow-lg">
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
        className="bg-transparent text-sm text-white outline-none w-48 placeholder-neutral-500"
      />
      <button
        onClick={() => onSearchPrevious(query)}
        className="p-0.5 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => onSearch(query)}
        className="p-0.5 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button onClick={onClose} className="text-neutral-500 hover:text-white text-sm ml-1">
        &times;
      </button>
    </div>
  );
}
