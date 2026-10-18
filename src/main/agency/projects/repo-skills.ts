import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  skillsIn,
  type MemberSkills,
  type RuntimeSkills
} from '../../../shared/agency-agent-files';
import type { GitRun } from '../repo-identity';
import { defaultRef, repoFacts } from './repo-reader';
import type { ProjectMember } from './workspace-projects';

const SKILL_DIRS = ['.claude/skills', '.eva/skills', '.agents/skills'];

/**
 * The skills Claude Code and eva load in a repository's root, at its default
 * branch tip as job worktrees start from it. Only the skill folders are
 * listed, so a large repository costs no more than a small one. A repository
 * with no commit on it yet is read from its working tree.
 */
export async function repoSkills(
  root: string,
  defaultBranch: string | null,
  git: GitRun
): Promise<RuntimeSkills> {
  const ref = await defaultRef(root, defaultBranch, git);
  if (ref !== null) {
    const out = await git(['ls-tree', '-r', '--name-only', '-z', ref, '--', ...SKILL_DIRS], root);
    return skillsIn((out ?? '').split('\0'));
  }
  const paths: string[] = [];
  for (const dir of SKILL_DIRS) {
    for (const name of await readdir(join(root, dir)).catch(() => [])) {
      const file = `${dir}/${name}/SKILL.md`;
      if ((await stat(join(root, file)).catch(() => null))?.isFile()) paths.push(file);
    }
  }
  return skillsIn(paths);
}

/** Each member's skills, for the Admiral's note. A member git cannot read lists none. */
export async function memberSkills(members: ProjectMember[], git: GitRun): Promise<MemberSkills[]> {
  const none: RuntimeSkills = { claude: [], eva: [] };
  return Promise.all(
    members.map(async (m) => ({
      member: m.name,
      atRoot: m.path === '.',
      skills: await repoFacts(m.root, git)
        .then(async ({ defaultBranch }) => repoSkills(m.root, defaultBranch, git))
        .catch(() => none)
    }))
  );
}
