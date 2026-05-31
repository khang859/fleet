import type { SwarmWorkerSpec, TaskComment } from '../../shared/kanban-types';

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
      skills = tail.split(',').map((s) => s.trim()).filter(Boolean);
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
export function latestBlackboard(
  store: BlackboardStore,
  rootId: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const authors: Record<string, string> = {};
  for (const comment of store.listComments(rootId)) {
    const body = comment.body ?? '';
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
