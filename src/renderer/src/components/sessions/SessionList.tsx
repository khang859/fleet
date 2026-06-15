// src/renderer/src/components/sessions/SessionList.tsx
import { useMemo, useState } from 'react';
import type { SessionAgentFilter, SessionGroup, SessionSummary } from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';
import { useSettingsStore } from '../../store/settings-store';

function isAgentFilter(v: string): v is SessionAgentFilter {
  return v === 'all' || v === 'rune' || v === 'claude';
}

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
  const { settings, updateSettings } = useSettingsStore();
  const filter: SessionAgentFilter = settings?.sessions.preferredAgent ?? 'rune';
  const [query, setQuery] = useState('');

  const setFilter = (next: SessionAgentFilter): void => {
    void updateSettings({ sessions: { preferredAgent: next } });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions
      .filter((s) => filter === 'all' || s.agent === filter)
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q)
      );
    return groupByProject(filtered);
  }, [sessions, filter, query]);

  return (
    <div className="flex h-full flex-col border-r border-fleet-border">
      <div className="flex items-center gap-2 border-b border-fleet-border px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          className="flex-1 rounded bg-fleet-surface px-2 py-1 text-sm text-fleet-text border border-fleet-border-strong"
        />
        <select
          value={filter}
          onChange={(e) => {
            if (isAgentFilter(e.target.value)) setFilter(e.target.value);
          }}
          className="rounded bg-fleet-surface px-2 py-1 text-sm text-fleet-text border border-fleet-border-strong"
        >
          <option value="all">All</option>
          <option value="rune">Rune</option>
          <option value="claude">Claude Code</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-fleet-text-subtle">No sessions.</div>
        ) : (
          groups.map((g) => (
            <div key={g.cwd}>
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-fleet-text-subtle bg-fleet-surface/40 truncate">
                {g.project}
              </div>
              {g.sessions.map((s) => {
                const sel = selected;
                const isSel = sel !== null && sel.agent === s.agent && sel.id === s.id;
                return (
                  <div
                    key={`${s.agent}-${s.id}`}
                    onClick={() => void select(s)}
                    className={`cursor-pointer px-3 py-2 border-b border-fleet-border/40 ${isSel ? 'bg-blue-600/15' : 'hover:bg-fleet-surface-2/50'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-fleet-text">{s.title}</span>
                      <span className="flex-shrink-0 text-[10px] text-fleet-text-subtle">
                        {relativeTime(s.updatedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-fleet-text-subtle">
                      <span className="rounded bg-fleet-surface-2 px-1">{s.agent}</span>
                      {s.model && <span className="truncate">{s.model}</span>}
                      <span>· {s.messageCount} msgs</span>
                      {s.agent === 'claude' && (
                        <span
                          className="ml-auto flex-shrink-0 font-mono text-fleet-text"
                          title={
                            s.costUsd === undefined
                              ? 'Cost unavailable — a model in this session is not in the pricing table'
                              : 'Estimated session cost'
                          }
                        >
                          {s.costUsd === undefined ? '—' : formatCost(s.costUsd)}
                        </span>
                      )}
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
