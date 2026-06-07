import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEBOUNCE_MS = 80;

// `CSS.highlights` (the registry) and `Highlight` (the constructor) are separate
// globals — both are needed before we can paint anything.
const supported =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export type MarkdownFind = {
  query: string;
  setQuery: (q: string) => void;
  matchCount: number;
  /** 0-based index of the active match, or -1 when there are no matches. */
  currentIndex: number;
  next: () => void;
  prev: () => void;
  clear: () => void;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrollToRange(range: Range): void {
  range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Find-in-document for the markdown preview. Walks the rendered text nodes inside
 * `containerRef`, builds a Range per match and paints them with the CSS Custom
 * Highlight API — so nothing in react-markdown's DOM is mutated and highlights
 * survive re-renders. `contentKey` (the preview source) re-runs the search whenever
 * the rendered content changes.
 *
 * The highlight registry (`CSS.highlights`) is a document-global keyed by name, so
 * each instance namespaces its names with `paneId` and injects matching `::highlight()`
 * rules — otherwise two markdown previews (e.g. side by side in a split) would clobber
 * each other's highlights.
 */
export function useMarkdownFind(
  containerRef: React.RefObject<HTMLElement | null>,
  contentKey: string,
  paneId: string
): MarkdownFind {
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);

  const rangesRef = useRef<Range[]>([]);
  const indexRef = useRef(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-pane highlight names (sanitized to a valid CSS custom-ident).
  const { allName, currentName } = useMemo(() => {
    const safe = paneId.replace(/[^a-zA-Z0-9_-]/g, '');
    return { allName: `md-find-${safe}`, currentName: `md-find-current-${safe}` };
  }, [paneId]);

  // Inject the `::highlight()` color rules for this instance's names.
  useEffect(() => {
    if (!supported) return;
    const style = document.createElement('style');
    style.textContent =
      `::highlight(${allName}){background-color:rgba(250,204,21,0.35);color:inherit}` +
      `::highlight(${currentName}){background-color:rgba(250,204,21,0.85);color:rgb(10 10 10)}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [allName, currentName]);

  const clear = useCallback(() => {
    rangesRef.current = [];
    indexRef.current = -1;
    setMatchCount(0);
    setCurrentIndex(-1);
    if (supported) {
      CSS.highlights.delete(allName);
      CSS.highlights.delete(currentName);
    }
  }, [allName, currentName]);

  const applyCurrent = useCallback(
    (index: number) => {
      if (!supported) return;
      CSS.highlights.delete(currentName);
      const ranges = rangesRef.current;
      if (index < 0 || index >= ranges.length) return;
      const range = ranges[index];
      CSS.highlights.set(currentName, new Highlight(range));
      scrollToRange(range);
    },
    [currentName]
  );

  const runSearch = useCallback(() => {
    const container = containerRef.current;
    if (supported) {
      CSS.highlights.delete(allName);
      CSS.highlights.delete(currentName);
    }
    if (!query || !container) {
      rangesRef.current = [];
      indexRef.current = -1;
      setMatchCount(0);
      setCurrentIndex(-1);
      return;
    }

    const re = new RegExp(escapeRegExp(query), 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const ranges: Range[] = [];
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const text = node.textContent ?? '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        ranges.push(range);
        if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length loops
      }
    }

    rangesRef.current = ranges;
    if (supported && ranges.length > 0) {
      CSS.highlights.set(allName, new Highlight(...ranges));
    }
    setMatchCount(ranges.length);
    const nextIndex = ranges.length > 0 ? 0 : -1;
    indexRef.current = nextIndex;
    setCurrentIndex(nextIndex);
    applyCurrent(nextIndex);
  }, [query, containerRef, applyCurrent, allName, currentName]);

  // Re-run (debounced) whenever the query or rendered content changes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runSearch, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [runSearch, contentKey]);

  // Clear this pane's highlights when the consumer unmounts.
  useEffect(() => clear, [clear]);

  const move = useCallback(
    (delta: number) => {
      const count = rangesRef.current.length;
      if (count === 0) return;
      const nextIndex = (indexRef.current + delta + count) % count;
      indexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
      applyCurrent(nextIndex);
    },
    [applyCurrent]
  );

  const next = useCallback(() => move(1), [move]);
  const prev = useCallback(() => move(-1), [move]);

  return { query, setQuery, matchCount, currentIndex, next, prev, clear };
}
