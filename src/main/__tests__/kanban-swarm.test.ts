import { describe, it, expect } from 'vitest';
import { parseWorkerArg, swarmContext, BLACKBOARD_PREFIX } from '../kanban/kanban-swarm';

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
