import { describe, it, expect } from 'vitest';
import { applyAgentFilter, groupByProject } from '../aggregate';
import type { SessionSummary } from '../../../shared/sessions';

const make = (over: Partial<SessionSummary>): SessionSummary => ({
  agent: 'rune',
  id: 'x',
  title: 't',
  project: 'p',
  cwd: '/p',
  updatedAt: 0,
  messageCount: 1,
  preview: '',
  ...over
});

const SESSIONS = [
  make({ id: 'r1', agent: 'rune', project: 'myapp', cwd: '/myapp', updatedAt: 100 }),
  make({ id: 'c1', agent: 'claude', project: 'myapp', cwd: '/myapp', updatedAt: 300 }),
  make({ id: 'r2', agent: 'rune', project: 'fleet', cwd: '/fleet', updatedAt: 200 })
];

describe('applyAgentFilter', () => {
  it('all returns everything', () => {
    expect(applyAgentFilter(SESSIONS, 'all')).toHaveLength(3);
  });
  it('filters by agent', () => {
    expect(applyAgentFilter(SESSIONS, 'rune').map((s) => s.id)).toEqual(['r1', 'r2']);
    expect(applyAgentFilter(SESSIONS, 'claude').map((s) => s.id)).toEqual(['c1']);
  });
});

describe('groupByProject', () => {
  it('groups by cwd, newest session first within group, groups ordered by newest', () => {
    const groups = groupByProject(SESSIONS);
    // myapp group's newest is c1 (300) > fleet's r2 (200), so myapp comes first
    expect(groups.map((g) => g.project)).toEqual(['myapp', 'fleet']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['c1', 'r1']);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['r2']);
  });
});
