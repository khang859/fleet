import type { CrewRuntime } from './agency-crew';

/**
 * Agent and skill files a project's repositories already have, by path.
 * Paths are from the project root, so a member's file has the member's path
 * in front: `fola-journey/.claude/agents/reviewer.md`.
 *
 * An agent file becomes a project crew role when the client imports it. A
 * skill stays where it is: Claude Code and eva load the ones in their working
 * folder and in each folder above it up to the nearest `.git`, so a member
 * that is its own repository gets only its own.
 */

/** The runtime each agent folder's files are written for. opencode's run on eva, the runtime like it. */
const AGENT_RUNTIME: Record<string, CrewRuntime> = {
  claude: 'claude',
  opencode: 'eva',
  eva: 'eva',
  agents: 'eva'
};

/** The runtime that loads each skill folder. */
const SKILL_RUNTIME: Record<string, CrewRuntime> = { claude: 'claude', eva: 'eva', agents: 'eva' };

const AGENT_PATH = /^(?:(.+)\/)?\.(claude|opencode|eva|agents)\/agents\/([^/]+)\.md$/;
const SKILL_PATH = /^(?:(.+)\/)?\.(claude|eva|agents)\/skills\/([^/]+)$/;

/** A crew role name, from a file name: lower-case letters, digits and dashes. */
export function roleNameOf(fileName: string): string | null {
  const name = fileName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return name === '' ? null : name;
}

/** A path `pattern` matches: the folder it is in, the dot folder's tool, and the file or folder name. */
function dotPath(
  pattern: RegExp,
  path: string
): { folder: string; tool: string; name: string } | null {
  const m = pattern.exec(path);
  if (m === null || path.split('/').includes('..')) return null;
  return { folder: m.at(1) ?? '.', tool: m[2], name: m[3] };
}

/** An agent file: the folder it is in (`.` for the project root), the role it makes and that role's runtime. */
export function agentFile(
  path: string
): { folder: string; role: string; runtime: CrewRuntime } | null {
  const found = dotPath(AGENT_PATH, path);
  const role = found && roleNameOf(found.name);
  if (found === null || role === null) return null;
  return { folder: found.folder, role, runtime: AGENT_RUNTIME[found.tool] };
}

/** A skill folder: the folder it is in (`.` for the project root), its name and the runtime that loads it. */
export function skillFolder(
  path: string
): { folder: string; name: string; runtime: CrewRuntime } | null {
  const found = dotPath(SKILL_PATH, path);
  return found && { folder: found.folder, name: found.name, runtime: SKILL_RUNTIME[found.tool] };
}

/** The skills each runtime loads in one repository's root, by name. */
export type RuntimeSkills = Record<CrewRuntime, string[]>;

/** The skills in a repository's root, from the paths of its files. */
export function skillsIn(paths: Iterable<string>): RuntimeSkills {
  const found: Record<CrewRuntime, Set<string>> = { claude: new Set(), eva: new Set() };
  for (const path of paths) {
    if (!path.endsWith('/SKILL.md')) continue;
    const skill = skillFolder(path.slice(0, -'/SKILL.md'.length));
    if (skill?.folder === '.') found[skill.runtime].add(skill.name);
  }
  return { claude: [...found.claude].sort(), eva: [...found.eva].sort() };
}

/** The skills a project member's repository has, for the Admiral's note. */
export type MemberSkills = { member: string; atRoot: boolean; skills: RuntimeSkills };
