import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, Search, SearchX, Eye, EyeOff, Copy, Check, X } from 'lucide-react';
import type { ShellEnvSnapshot, ShellEnvVar } from '../../../../shared/shell-env-types';
import {
  SECTIONS,
  isSecret,
  filterVars,
  varsForSection,
  formatSpawnTime,
  clampSelection
} from './shell-env-view';

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
  const selectedRowRef = useRef<HTMLDivElement>(null);

  // Load the snapshot each time the modal opens for the focused pane.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setRevealAll(false);
    setRevealed(new Set());
    setSelected(0);
    if (!paneId) {
      setSnapshot(null);
      setLoading(false);
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
    if (!snapshot) return [];
    const filtered = filterVars(snapshot.vars, query);
    return SECTIONS.flatMap((s) => varsForSection(filtered, s.source));
  }, [snapshot, query]);

  useEffect(() => {
    setSelected((i) => clampSelection(i, visible.length));
  }, [visible.length]);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

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
        setSelected((i) => clampSelection(i + 1, visible.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => clampSelection(i - 1, visible.length));
      } else if (e.key === 'Enter') {
        if (e.target !== inputRef.current) return;
        e.preventDefault();
        const v = visible.at(selected);
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
        className="flex max-h-[72vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-fleet-border bg-fleet-surface shadow-2xl duration-150 animate-in fade-in-0 zoom-in-95"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-fleet-border px-5 py-3">
          <div className="flex items-center gap-2 text-fleet-text">
            <Terminal size={16} className="text-fleet-text-muted" />
            <h2 className="text-sm font-semibold">
              {snapshot ? snapshot.shellName : 'Shell Environment'}
            </h2>
          </div>
          {snapshot?.cwd && (
            <div
              title={snapshot.cwd}
              className="flex items-center gap-1.5 rounded-md bg-fleet-surface-2 px-2.5 py-1 text-xs text-fleet-text-secondary"
            >
              <span className="max-w-[260px] truncate font-mono">{snapshot.cwd}</span>
            </div>
          )}
          <button
            onClick={() => setRevealAll((v) => !v)}
            onMouseDown={(e) => e.preventDefault()}
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fleet-text-secondary transition hover:bg-fleet-surface-2 active:scale-95"
          >
            {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealAll ? 'Hide all' : 'Reveal all'}
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-fleet-text-subtle transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text active:scale-90"
            aria-label="Close shell environment"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="relative px-5 py-2.5">
          <Search
            size={14}
            className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-fleet-text-subtle"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter variables…"
            aria-label="Filter environment variables"
            className="h-8 w-full rounded-md border border-white/10 bg-fleet-bg pl-8 pr-3 font-mono text-xs text-fleet-text-secondary placeholder:font-sans placeholder:text-fleet-text-subtle focus-visible:border-fleet-border-strong focus-visible:outline-none"
          />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-2">
          {loading ? null : !snapshot ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-fleet-text-subtle">
              <Terminal size={24} className="text-fleet-text-subtle" />
              <p className="text-sm">No shell in this pane</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2">
              <SearchX size={24} className="text-fleet-text-subtle" />
              <p className="text-sm text-fleet-text-muted">
                No variables match &lsquo;{query}&rsquo;
              </p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = varsForSection(filterVars(snapshot.vars, query), section.source);
              if (rows.length === 0) return null;
              // Share one key-column width across every row in the section so
              // values line up in a scannable column (capped so one long key
              // can't blow the column out; longer keys truncate).
              const keyCh = Math.min(40, Math.max(...rows.map((r) => r.key.length)));
              return (
                <div key={section.source}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 bg-fleet-surface/95 px-5 pb-2 pt-5 backdrop-blur-sm">
                    <span className={`h-2 w-2 rounded-full ${section.dotClass}`} />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-fleet-text-subtle">
                      {section.label}
                    </span>
                    <span className="text-[11px] text-fleet-text-subtle">· {rows.length}</span>
                  </div>
                  {rows.map((v) => {
                    const reveal = revealAll || revealed.has(v.key);
                    const masked = isSecret(v) && !reveal;
                    const isSelected = visible[selected]?.key === v.key;
                    return (
                      <div
                        key={v.key}
                        ref={isSelected ? selectedRowRef : undefined}
                        style={{ gridTemplateColumns: `minmax(0, ${keyCh}ch) minmax(0, 1fr) auto` }}
                        className={`group mx-2 grid h-8 items-center rounded-md px-3 font-mono ${
                          isSelected
                            ? 'bg-fleet-surface-2/60 ring-1 ring-inset ring-white/10'
                            : 'hover:bg-fleet-surface-2/50'
                        }`}
                      >
                        <span
                          className={`truncate pr-4 font-mono text-xs font-medium ${
                            isSelected ? 'text-fleet-text' : 'text-fleet-text-secondary'
                          }`}
                        >
                          {v.key}
                        </span>
                        <span
                          title={masked ? undefined : v.value}
                          className={`truncate font-mono text-xs ${masked ? 'text-fleet-text-subtle' : 'text-fleet-text-muted'}`}
                        >
                          {masked ? '••••••••' : v.value}
                        </span>
                        <span
                          className={`flex items-center gap-0.5 transition group-hover:opacity-100 focus-within:opacity-100 ${
                            isSelected ? 'opacity-100' : 'opacity-0'
                          }`}
                        >
                          {isSecret(v) && (
                            <button
                              onClick={() => toggleReveal(v.key)}
                              onMouseDown={(e) => e.preventDefault()}
                              title={reveal ? 'Hide value' : 'Reveal value'}
                              aria-label={reveal ? 'Hide value' : 'Reveal value'}
                              aria-pressed={reveal}
                              className="flex h-6 w-6 items-center justify-center rounded-md text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text-secondary"
                            >
                              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
                          <button
                            onClick={() => copyValue(v)}
                            onMouseDown={(e) => e.preventDefault()}
                            title="Copy value"
                            aria-label="Copy value"
                            className="flex h-6 w-6 items-center justify-center rounded-md text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text-secondary"
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
          <div className="flex items-center justify-between border-t border-fleet-border px-5 py-2 text-[11px] text-fleet-text-subtle">
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
