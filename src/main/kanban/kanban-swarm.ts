import type { SwarmWorkerSpec } from '../../shared/kanban-types';

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
