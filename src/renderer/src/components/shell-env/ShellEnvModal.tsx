import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, Search, SearchX, Eye, EyeOff, Copy, Check, X } from 'lucide-react';
import type { ShellEnvSnapshot, ShellEnvVar } from '../../../../shared/shell-env-types';
import { SECTIONS, isSecret, filterVars, varsForSection, formatSpawnTime } from './shell-env-view';

export function ShellEnvModal({
  isOpen,
  onClose,
  paneId
}: {
  isOpen: boolean;
  onClose: () => void;
  paneId: string | null;
}): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ShellEnvSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the snapshot each time the modal opens for the focused pane.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setRevealAll(false);
    setRevealed(new Set());
    setSelected(0);
    if (!paneId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    void window.fleet.shellEnv.get(paneId).then((snap) => {
      if (cancelled) return;
      setSnapshot(snap);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, paneId]);

  // Autofocus the search input on open.
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Flat list of currently-visible rows, in section order, for keyboard nav.
  const visible = useMemo(() => {
    if (!snapshot) return [] as ShellEnvVar[];
    const filtered = filterVars(snapshot.vars, query);
    return SECTIONS.flatMap((s) => varsForSection(filtered, s.source));
  }, [snapshot, query]);

  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  const copyValue = useCallback((v: ShellEnvVar) => {
    void navigator.clipboard.writeText(v.value);
    setCopiedKey(v.key);
    setTimeout(() => setCopiedKey((k) => (k === v.key ? null : k)), 1200);
  }, []);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, visible.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (e.target !== inputRef.current) return;
        e.preventDefault();
        const v = visible[selected];
        if (v) copyValue(v);
      }
    },
    [visible, selected, copyValue, onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 duration-150 animate-in fade-in-0"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex max-h-[72vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl duration-150 animate-in fade-in-0 zoom-in-95"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="flex items-center gap-2 text-neutral-100">
            <Terminal size={16} className="text-neutral-400" />
            <h2 className="text-sm font-semibold">
              {snapshot ? snapshot.shellName : 'Shell Environment'}
            </h2>
          </div>
          {snapshot?.cwd && (
            <div
              title={snapshot.cwd}
              className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300"
            >
              <span className="max-w-[260px] truncate">{snapshot.cwd}</span>
            </div>
          )}
          <button
            onClick={() => setRevealAll((v) => !v)}
            onMouseDown={(e) => e.preventDefault()}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
          >
            {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealAll ? 'Hide all' : 'Reveal all'}
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
            aria-label="Close shell environment"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="relative px-5 py-2.5">
          <Search
            size={14}
            className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter variables…"
            aria-label="Filter environment variables"
            className="h-8 w-full rounded-md border border-neutral-800 bg-neutral-950 pl-8 pr-3 font-mono text-xs text-neutral-200 placeholder:font-sans placeholder:text-neutral-600 focus-visible:border-neutral-600 focus-visible:outline-none"
          />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-2">
          {loading ? null : !snapshot ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-neutral-500">
              <Terminal size={24} className="text-neutral-600" />
              <p className="text-sm">No shell in this pane</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2">
              <SearchX size={24} className="text-neutral-600" />
              <p className="text-sm text-neutral-400">No variables match &lsquo;{query}&rsquo;</p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = varsForSection(filterVars(snapshot.vars, query), section.source);
              if (rows.length === 0) return null;
              return (
                <div key={section.source}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-neutral-900/95 px-5 pb-1.5 pt-4 backdrop-blur-sm">
                    <span className={`h-2 w-2 rounded-full ${section.dotClass}`} />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                      {section.label}
                    </span>
                    <span className="text-[11px] text-neutral-600">· {rows.length}</span>
                  </div>
                  {rows.map((v) => {
                    const reveal = revealAll || revealed.has(v.key);
                    const masked = isSecret(v) && !reveal;
                    const isSelected = visible[selected]?.key === v.key;
                    return (
                      <div
                        key={v.key}
                        className={`group mx-2 grid h-8 grid-cols-[minmax(140px,max-content)_1fr_auto] items-center rounded-md px-3 ${
                          isSelected ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/50'
                        }`}
                      >
                        <span
                          className={`truncate pr-4 font-mono text-xs font-medium ${
                            isSelected ? 'text-neutral-50' : 'text-neutral-200'
                          }`}
                        >
                          {v.key}
                        </span>
                        <span
                          title={masked ? undefined : v.value}
                          className="truncate font-mono text-xs text-neutral-400"
                        >
                          {masked ? '••••••••' : v.value}
                        </span>
                        <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                          {isSecret(v) && (
                            <button
                              onClick={() => toggleReveal(v.key)}
                              onMouseDown={(e) => e.preventDefault()}
                              title={reveal ? 'Hide value' : 'Reveal value'}
                              aria-label={reveal ? 'Hide value' : 'Reveal value'}
                              aria-pressed={reveal}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                            >
                              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
                          <button
                            onClick={() => copyValue(v)}
                            onMouseDown={(e) => e.preventDefault()}
                            title="Copy value"
                            aria-label="Copy value"
                            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                          >
                            {copiedKey === v.key ? (
                              <Check size={13} className="text-emerald-400" />
                            ) : (
                              <Copy size={13} />
                            )}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        {snapshot && (
          <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-2 text-[11px] text-neutral-500">
            <span>
              Snapshot at shell launch ({formatSpawnTime(snapshot.spawnedAt)}) · variables exported
              after launch aren&rsquo;t shown.
            </span>
            <span>{snapshot.vars.length} variables</span>
          </div>
        )}
      </div>
    </div>
  );
}
