import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseWorkerArg,
  swarmContext,
  BLACKBOARD_PREFIX,
  postBlackboardUpdate,
  latestBlackboard,
  createSwarm,
  isSwarmRoot
} from '../kanban/kanban-swarm';
import { KanbanStore } from '../kanban/kanban-store';
import type { TaskComment } from '../../shared/kanban-types';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SWARM_DIR = join(tmpdir(), `fleet-swarm-test-${Date.now()}`);

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

describe('createSwarm topology', () => {
  beforeEach(() => mkdirSync(SWARM_DIR, { recursive: true }));
  afterEach(() => rmSync(SWARM_DIR, { recursive: true, force: true }));

  function store(): KanbanStore {
    return new KanbanStore(join(SWARM_DIR, `s-${Math.random()}.db`));
  }

  it('builds root(done) → workers(todo) → verifier(todo) → synthesizer(todo)', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'Design a failover plan',
      workers: [
        { profile: 'researcher', title: 'Research', body: 'Research', skills: [] },
        { profile: 'architect', title: 'Architect', body: 'Architect', skills: ['systems'] }
      ],
      verifierAssignee: 'reviewer',
      synthesizerAssignee: 'writer'
    });

    const root = s.getTask(created.rootId)!;
    expect(root.status).toBe('done');

    expect(created.workerIds).toHaveLength(2);
    for (const id of created.workerIds) {
      const w = s.getTask(id)!;
      expect(w.status).toBe('todo');
      expect(w.assignee).not.toBeNull();
      expect(s.parentsOf(id)).toEqual([created.rootId]);
      expect(w.body).toContain('## Swarm protocol');
    }
    expect(s.getTask(created.workerIds[1])!.skills).toEqual(['systems']);

    const verifier = s.getTask(created.verifierId)!;
    expect(verifier.status).toBe('todo');
    expect(verifier.assignee).toBe('reviewer');
    expect(verifier.skills).toEqual(['requesting-code-review']);
    expect(s.parentsOf(created.verifierId).sort()).toEqual([...created.workerIds].sort());

    const synth = s.getTask(created.synthesizerId)!;
    expect(synth.status).toBe('todo');
    expect(synth.assignee).toBe('writer');
    expect(s.parentsOf(created.synthesizerId)).toEqual([created.verifierId]);
  });

  it('stores topology on the blackboard and is detectable as a swarm root', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y'
    });
    const bb = latestBlackboard(s, created.rootId);
    expect((bb.topology as { kind: string }).kind).toBe('kanban_swarm_v1');
    expect(isSwarmRoot(s, created.rootId)).toBe(true);
    expect(isSwarmRoot(s, created.verifierId)).toBe(false);
  });

  it('applies workspaceKind to every card', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y',
      workspaceKind: 'worktree',
      repoPath: '/tmp/repo'
    });
    expect(s.getTask(created.workerIds[0])!.workspaceKind).toBe('worktree');
    expect(s.getTask(created.synthesizerId)!.workspaceKind).toBe('worktree');
  });

  it('carries a dir workspacePath onto every card', () => {
    const s = store();
    const created = createSwarm(s, {
      goal: 'g',
      workers: [{ profile: 'w', title: 't', body: 't', skills: [] }],
      verifierAssignee: 'v',
      synthesizerAssignee: 'y',
      workspaceKind: 'dir',
      workspacePath: '/tmp/project'
    });
    for (const id of [created.workerIds[0], created.verifierId, created.synthesizerId]) {
      expect(s.getTask(id)!.workspaceKind).toBe('dir');
      expect(s.getTask(id)!.workspacePath).toBe('/tmp/project');
    }
  });
});
