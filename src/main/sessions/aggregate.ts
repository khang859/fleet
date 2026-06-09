// src/main/sessions/aggregate.ts
import type { SessionAgentFilter, SessionGroup, SessionSummary } from '../../shared/sessions';

export function applyAgentFilter(
  sessions: SessionSummary[],
  filter: SessionAgentFilter
): SessionSummary[] {
  if (filter === 'all') return sessions;
  return sessions.filter((s) => s.agent === filter);
}

export function groupByProject(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const existing = groups.get(s.cwd);
    if (existing) existing.sessions.push(s);
    else groups.set(s.cwd, { project: s.project, cwd: s.cwd, sessions: [s] });
  }
  const result = [...groups.values()];
  for (const g of result) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  result.sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt);
  return result;
}
