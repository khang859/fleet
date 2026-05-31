import { describe, it, expect } from 'vitest';
import { parseWorkerArg, swarmContext, BLACKBOARD_PREFIX, postBlackboardUpdate, latestBlackboard } from '../kanban/kanban-swarm';
import type { TaskComment } from '../../shared/kanban-types';

function commentStore() {
  const rows: TaskComment[] = [];
  let id = 1;
  return {
    addComment(taskId: string, author: string, body: string): TaskComment {
      const c = { id: id++, taskId, author, body, createdAt: id };
      rows.push(c);
      return c;
    },
    listComments(taskId: string): TaskComment[] {
      return rows.filter((r) => r.taskId === taskId);
    }
  };
}

describe('parseWorkerArg', () => {
  it('parses profile:title', () => {
    expect(parseWorkerArg('researcher:Investigate funding')).toEqual({
      profile: 'researcher',
      title: 'Investigate funding',
      body: 'Investigate funding',
      skills: []
    });
  });

  it('parses profile:title:skill,skill', () => {
    expect(parseWorkerArg('sre:Audit infra:reliability,oncall')).toEqual({
      profile: 'sre',
      title: 'Audit infra',
      body: 'Audit infra',
      skills: ['reliability', 'oncall']
    });
  });

  it('keeps colons in the title (split limited to profile + remainder)', () => {
    const spec = parseWorkerArg('writer:Draft: the report');
    expect(spec.profile).toBe('writer');
    expect(spec.title).toBe('Draft: the report');
  });

  it('throws when there is no title', () => {
    expect(() => parseWorkerArg('researcher')).toThrow();
  });
});

describe('swarmContext', () => {
  it('names the root id and goal and the blackboard tools', () => {
    const ctx = swarmContext('root123', 'Design failover');
    expect(ctx).toContain('root123');
    expect(ctx).toContain('Design failover');
    expect(ctx).toContain('kanban_swarm_read');
    expect(ctx).toContain('kanban_swarm_post');
  });
});

describe('BLACKBOARD_PREFIX', () => {
  it('has the exact hermes value with a trailing space', () => {
    expect(BLACKBOARD_PREFIX).toBe('[swarm:blackboard] ');
  });
});

describe('blackboard', () => {
  it('round-trips a structured update', () => {
    const store = commentStore();
    postBlackboardUpdate(store, 'root', 'alice', 'finding', { score: 9 });
    expect(latestBlackboard(store, 'root')).toEqual({
      finding: { score: 9 },
      _authors: { finding: 'alice' }
    });
  });

  it('last write wins per key and tracks the winning author', () => {
    const store = commentStore();
    postBlackboardUpdate(store, 'root', 'alice', 'k', 1);
    postBlackboardUpdate(store, 'root', 'bob', 'k', 2);
    const bb = latestBlackboard(store, 'root');
    expect(bb.k).toBe(2);
    expect((bb._authors as Record<string, string>).k).toBe('bob');
  });

  it('ignores non-prefixed and unparseable comments', () => {
    const store = commentStore();
    store.addComment('root', 'human', 'just a normal comment');
    store.addComment('root', 'human', BLACKBOARD_PREFIX + 'not json');
    postBlackboardUpdate(store, 'root', 'alice', 'k', 'v');
    expect(latestBlackboard(store, 'root')).toEqual({ k: 'v', _authors: { k: 'alice' } });
  });

  it('returns an empty object when there are no blackboard comments', () => {
    const store = commentStore();
    expect(latestBlackboard(store, 'root')).toEqual({});
  });
});
