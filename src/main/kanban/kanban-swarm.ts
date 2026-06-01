import type {
  SwarmWorkerSpec,
  SwarmInput,
  SwarmCreated,
  TaskComment,
  Task,
  CreateTaskInput,
  WorkspaceKind
} from '../../shared/kanban-types';

export const BLACKBOARD_PREFIX = '[swarm:blackboard] ';

/** The "## Swarm protocol" suffix appended to every swarm card body. */
export function swarmContext(rootId: string, goal: string): string {
  return (
    '\n\n## Swarm protocol\n' +
    `- Swarm root / shared blackboard: ${rootId}.\n` +
    '- Read sibling/parent findings with the kanban_swarm_read tool (root above).\n' +
    '- Post cross-worker facts with the kanban_swarm_post tool (root above).\n' +
    `- Goal: ${goal.trim()}\n`
  );
}

/** Parse a CLI `--worker profile:title[:skill,skill]` value. Body defaults to the title. */
export function parseWorkerArg(raw: string): SwarmWorkerSpec {
  const firstColon = raw.indexOf(':');
  if (firstColon < 0) {
    throw new Error('worker must be profile:title or profile:title:skill,skill');
  }
  const profile = raw.slice(0, firstColon).trim();
  const rest = raw.slice(firstColon + 1);
  // Skills, if present, are the final ":a,b" segment.
  const lastColon = rest.lastIndexOf(':');
  let title = rest;
  let skills: string[] = [];
  if (lastColon >= 0) {
    const tail = rest.slice(lastColon + 1);
    // Treat the tail as skills only when it looks like a comma list of skill tokens.
    if (tail.trim() !== '' && /^[a-zA-Z0-9_,\- ]+$/.test(tail) && tail.includes(',')) {
      title = rest.slice(0, lastColon);
      skills = tail
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  title = title.trim();
  if (profile === '' || title === '') {
    throw new Error('worker must be profile:title or profile:title:skill,skill');
  }
  return { profile, title, body: title, skills };
}

/** The subset of KanbanStore the blackboard helpers need. */
export interface BlackboardStore {
  addComment(taskId: string, author: string, body: string): TaskComment;
  listComments(taskId: string): TaskComment[];
}

/** Append one structured update to a swarm root's blackboard. */
export function postBlackboardUpdate(
  store: BlackboardStore,
  rootId: string,
  author: string,
  key: string,
  value: unknown
): TaskComment {
  const body = BLACKBOARD_PREFIX + JSON.stringify({ key, value });
  return store.addComment(rootId, author, body);
}

/** Merge a root's blackboard comments, last-write-wins per key, with winning authors. */
export function latestBlackboard(store: BlackboardStore, rootId: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const authors: Record<string, string> = {};
  for (const comment of store.listComments(rootId)) {
    const body = comment.body;
    if (!body.startsWith(BLACKBOARD_PREFIX)) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(body.slice(BLACKBOARD_PREFIX.length));
    } catch {
      continue;
    }
    if (typeof payload !== 'object' || payload === null) continue;
    const key = (payload as { key?: unknown }).key;
    if (typeof key !== 'string' || key === '') continue;
    merged[key] = (payload as { value?: unknown }).value;
    authors[key] = comment.author;
  }
  if (Object.keys(authors).length > 0) merged._authors = authors;
  return merged;
}

/** The subset of KanbanStore createSwarm needs. Extends BlackboardStore. */
export interface SwarmStore extends BlackboardStore {
  createTask(input: CreateTaskInput): Task;
  completeTask(taskId: string, result: string | null): void;
  addLink(parentId: string, childId: string): void;
  getTask(id: string): Task | null;
}

const SWARM_ROOT_KIND = 'kanban_swarm_v1';

/** True when `rootId` is a swarm root (its blackboard carries the topology marker). */
export function isSwarmRoot(store: BlackboardStore, rootId: string): boolean {
  const topology = latestBlackboard(store, rootId).topology;
  return (
    typeof topology === 'object' &&
    topology !== null &&
    (topology as { kind?: unknown }).kind === SWARM_ROOT_KIND
  );
}

/**
 * Create a swarm graph. The root is created then completed immediately; workers,
 * verifier, and synthesizer are created `todo` with the gating links. Emits no
 * events (the caller wraps this in a transaction and emits after commit).
 */
export function createSwarm(store: SwarmStore, input: SwarmInput): SwarmCreated {
  const goal = input.goal.trim();
  const createdBy = input.createdBy ?? 'swarm-orchestrator';
  const workspaceKind: WorkspaceKind = input.workspaceKind ?? 'scratch';
  const common = {
    boardId: input.boardId,
    tenant: input.tenant ?? null,
    workspaceKind,
    repoPath: input.repoPath,
    // Worktree workers branch from the orchestrator's base so they inherit its
    // merged work (matches kanban_create's child inheritance).
    baseBranch: input.baseBranch ?? null,
    // 'dir' swarms run every node directly in the shared folder; carry the path
    // so it survives onto each task instead of falling back to a scratch sandbox.
    workspacePath: input.workspacePath ?? undefined,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? null
  };

  // Root.
  const root = store.createTask({
    title: input.rootTitle ?? `Swarm: ${goal.split('\n')[0].slice(0, 80)}`,
    body:
      'Kanban Swarm planning/root card. Completed immediately so workers can start; ' +
      `remains the shared blackboard and audit anchor.\n\nGoal:\n${goal}`,
    assignee: createdBy,
    priority: input.priority ?? 0,
    ...common
  });
  store.completeTask(root.id, 'Swarm topology planned; root is the shared blackboard.');

  const suffix = swarmContext(root.id, goal);

  // Workers.
  const workerIds: string[] = [];
  for (const spec of input.workers) {
    const w = store.createTask({
      title: spec.title,
      body: (spec.body ?? spec.title) + suffix,
      assignee: spec.profile,
      status: 'todo',
      priority: spec.priority ?? input.priority ?? 0,
      skills: spec.skills ?? [],
      ...common
    });
    store.addLink(root.id, w.id);
    workerIds.push(w.id);
  }

  // Verifier (gated on all workers).
  const verifier = store.createTask({
    title: input.verifierTitle ?? 'Verify swarm outputs',
    body:
      'Review every worker handoff and blackboard update. Complete ONLY when the ' +
      'evidence is sufficient; otherwise block with the exact missing work (blocking ' +
      'withholds the synthesizer).' +
      suffix,
    assignee: input.verifierAssignee,
    status: 'todo',
    priority: input.priority ?? 0,
    skills: ['requesting-code-review'],
    ...common
  });
  for (const id of workerIds) store.addLink(id, verifier.id);

  // Synthesizer (gated on verifier).
  const synthesizer = store.createTask({
    title: input.synthesizerTitle ?? 'Synthesize swarm outputs',
    body:
      'Synthesize the verified worker outputs into the final deliverable. Read the ' +
      'blackboard for all findings.' +
      suffix,
    assignee: input.synthesizerAssignee,
    status: 'todo',
    priority: input.priority ?? 0,
    ...common
  });
  store.addLink(verifier.id, synthesizer.id);

  const created: SwarmCreated = {
    rootId: root.id,
    workerIds,
    verifierId: verifier.id,
    synthesizerId: synthesizer.id
  };
  postBlackboardUpdate(store, root.id, createdBy, 'topology', {
    kind: SWARM_ROOT_KIND,
    ...created,
    goal
  });
  return created;
}
