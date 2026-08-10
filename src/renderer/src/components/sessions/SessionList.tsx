// src/renderer/src/components/sessions/SessionList.tsx
import { useMemo, useState } from 'react';
import type { SessionGroup, SessionSummary } from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';

function groupByProject(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const g = groups.get(s.cwd);
    if (g) g.sessions.push(s);
    else groups.set(s.cwd, { project: s.project, cwd: s.cwd, sessions: [s] });
  }
  const result = [...groups.values()];
  for (const g of result) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  result.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
  return result;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function SessionList(): React.JSX.Element {
  const { sessions, selected, select } = useSessionsStore();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions.filter(
      (s) =>
        !q ||
        s.title.toLowerCase().includes(q) ||
        s.preview.toLowerCase().includes(q) ||
        s.project.toLowerCase().includes(q)
    );
    return groupByProject(filtered);
  }, [sessions, query]);

  return (
    <div className="flex h-full flex-col border-r border-fleet-border">
      <div className="flex items-center gap-2 border-b border-fleet-border px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          className="flex-1 rounded-md bg-fleet-surface px-2.5 py-1.5 text-sm text-fleet-text border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-fleet-text-subtle">No sessions.</div>
        ) : (
          groups.map((g) => (
            <div key={g.cwd}>
              {/* Sticky, so you can still tell which project you are scrolling
                  through a hundred sessions down. Sentence case rather than
                  letter-spaced caps, like every other group header now. */}
              <div className="sticky top-0 z-10 truncate bg-fleet-surface px-3 py-1.5 text-[11px] font-medium text-fleet-text-subtle">
                {g.project}
              </div>
              {g.sessions.map((s) => {
                const sel = selected;
                const isSel = sel !== null && sel.id === s.id;
                return (
                  // No rule under every row: separating a list with a hairline
                  // per item is what made this read as a table. Hover and
                  // selection carry it, with the accent bar the sidebar rows use.
                  <div
                    key={s.id}
                    onClick={() => void select(s)}
                    className={`cursor-pointer border-l-2 px-3 py-1.5 transition-colors ${
                      isSel
                        ? 'border-l-[color:var(--fleet-accent)] bg-fleet-surface-3'
                        : 'border-l-transparent hover:bg-fleet-surface-2'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-fleet-text">{s.title}</span>
                      <span className="flex-shrink-0 text-[10px] text-fleet-text-subtle">
                        {relativeTime(s.updatedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-fleet-text-subtle">
                      {s.models?.[0] && (
                        <>
                          <span className="truncate">{s.models[0]}</span>
                          <span className="flex-shrink-0">·</span>
                        </>
                      )}
                      <span className="flex-shrink-0">{s.messageCount} msgs</span>
                      <span
                        className={`ml-auto flex-shrink-0 font-mono fleet-tnum ${
                          // A dash means "no price for this model". Rendering it
                          // at full strength put the eye on the one cell that
                          // says nothing.
                          s.costUsd === undefined ? 'text-fleet-text-subtle' : 'text-fleet-text'
                        }`}
                        title={
                          s.costUsd === undefined
                            ? 'Cost unavailable — a model in this session is not in the pricing table'
                            : 'Estimated session cost'
                        }
                      >
                        {s.costUsd === undefined ? '—' : formatCost(s.costUsd)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
