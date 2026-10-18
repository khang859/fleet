import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readOnlyGit } from '../repo-reader';
import { repoSkills } from '../repo-skills';
import { git, initRepo, tempDir, writeFiles } from './git-fixture';

let tmp: { dir: string; cleanup: () => void };

beforeEach(() => {
  tmp = tempDir('fleet-repo-skills-');
});

afterEach(() => tmp.cleanup());

describe('repoSkills', () => {
  it('reads the default branch tip, not uncommitted skills', async () => {
    const root = initRepo(join(tmp.dir, 'journey'), {
      '.claude/skills/journey-qa-sweep/SKILL.md': '# Sweep\n',
      '.agents/skills/lint/SKILL.md': '# Lint\n',
      'src/.claude/skills/deep/SKILL.md': '# Deep\n'
    });
    writeFiles(root, { '.claude/skills/draft/SKILL.md': '# Draft\n' });
    expect(await repoSkills(root, 'main', readOnlyGit)).toEqual({
      claude: ['journey-qa-sweep'],
      eva: ['lint']
    });
  });

  it('reads the working tree of a repository with no commit yet', async () => {
    const root = join(tmp.dir, 'fresh');
    writeFiles(root, {
      '.eva/skills/deploy/SKILL.md': '# Deploy\n',
      '.eva/skills/empty/README.md': 'no skill here\n'
    });
    git(root, 'init', '-q', '-b', 'main');
    expect(await repoSkills(root, 'main', readOnlyGit)).toEqual({ claude: [], eva: ['deploy'] });
  });
});
