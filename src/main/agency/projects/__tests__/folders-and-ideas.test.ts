import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoIdentity } from '../../repo-identity';
import { AgencyStore } from '../../store/agency-store';
import { briefIdeas, changelogIdea } from '../brief-ideas';
import { probeFolders } from '../folders';
import { readOnlyGit } from '../repo-reader';
import { fakeGh, initRepo, tempDir } from './git-fixture';

/** The picker's folder states, and the empty lobby's brief ideas with and without GitHub. */

let tmp: { dir: string; cleanup: () => void };
let store: AgencyStore;
beforeEach(() => {
  tmp = tempDir('fleet-folders-');
  store = new AgencyStore(join(tmp.dir, 'agency.db'));
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

const NOT_SET_UP = { setupDoneAt: null, starterDoneAt: null };

describe('probeFolders', () => {
  it('tells a repository from a folder that is not one, and a repository with no remote', async () => {
    const shop = initRepo(
      join(tmp.dir, 'shop'),
      { 'README.md': 'x' },
      {
        origin: 'https://github.com/acme/shop.git'
      }
    );
    const notebook = initRepo(join(tmp.dir, 'notebook'), { 'notes.md': 'x' });
    const downloads = join(tmp.dir, 'Downloads');
    mkdirSync(downloads);
    mkdirSync(join(shop, 'src'));

    const folders = await probeFolders(
      [join(shop, 'src'), shop, notebook, downloads, join(tmp.dir, 'gone')],
      {
        identify: async (p) => resolveRepoIdentity(p),
        git: readOnlyGit,
        onboarding: () => NOT_SET_UP,
        registry: store.projects
      }
    );

    expect(folders).toEqual([
      // A folder inside a repository is the repository, once.
      expect.objectContaining({
        kind: 'repo',
        path: shop,
        branch: 'main',
        remote: 'github.com/acme/shop',
        teamFiles: false,
        setupDone: false
      }),
      expect.objectContaining({ kind: 'repo', path: notebook, remote: null }),
      { kind: 'not-a-repo', path: downloads }
    ]);
  });
});

describe('brief ideas', () => {
  const RUNS = [
    { workflowName: 'CI', displayTitle: 'Fix login', conclusion: 'failure', headBranch: 'main' },
    { workflowName: 'CI', displayTitle: 'Tabs', conclusion: 'success', headBranch: 'main' },
    { workflowName: 'E2E', displayTitle: 'Tabs', conclusion: 'success', headBranch: 'main' },
    { workflowName: 'E2E', displayTitle: 'Tabs', conclusion: 'failure', headBranch: 'main' },
    { workflowName: 'E2E', displayTitle: 'Tabs', conclusion: 'failure', headBranch: 'main' },
    { workflowName: 'Docs', displayTitle: 'Tabs', conclusion: 'success', headBranch: 'main' }
  ];
  const gh = fakeGh((args) => {
    if (args[0] === 'auth') return { code: 0, stdout: '' };
    if (args[0] === 'issue') {
      return { code: 0, stdout: JSON.stringify([{ number: 318, title: 'Savings goals' }]) };
    }
    if (args[0] === 'run') return { code: 0, stdout: JSON.stringify(RUNS) };
    return null;
  });
  const CHANGELOG =
    '# Changelog\n\n## v2.1.0\n\n- Tabs can be dragged between windows.\n- Fewer crashes.\n\n## v2.0.0\n\n- Old.\n';

  it('offers open issues, failing and flaky CI, and the newest changelog entry', async () => {
    const root = initRepo(
      join(tmp.dir, 'shop'),
      { 'CHANGELOG.md': CHANGELOG },
      {
        origin: 'git@github.com:acme/shop.git'
      }
    );
    const ideas = await briefIdeas(root, { gh });
    expect(ideas.github).toBe('ok');
    expect(ideas.ideas.map((i) => [i.tag, i.title])).toEqual([
      ['Issue #318', 'Savings goals'],
      ['Failing CI', 'CI is failing on main'],
      ['Flaky CI', 'E2E failed 2 of the last 3 runs on main'],
      ['Changelog', 'Follow up on v2.1.0: Tabs can be dragged between windows.']
    ]);
  });

  it('falls back to the changelog without the GitHub CLI, and says why', async () => {
    const root = initRepo(
      join(tmp.dir, 'shop'),
      { 'CHANGELOG.md': CHANGELOG },
      {
        origin: 'git@github.com:acme/shop.git'
      }
    );
    const ideas = await briefIdeas(root, { gh: fakeGh(() => null) });
    expect(ideas.github).toBe('not-installed');
    expect(ideas.ideas.map((i) => i.kind)).toEqual(['changelog']);
  });

  it('does not ask GitHub about a repository that is not on it', async () => {
    const root = initRepo(join(tmp.dir, 'notebook'), { 'notes.md': 'x' });
    let asked = false;
    const ideas = await briefIdeas(root, {
      gh: fakeGh(() => {
        asked = true;
        return null;
      })
    });
    expect(ideas).toEqual({ ideas: [], github: 'no-remote' });
    expect(asked).toBe(false);
  });

  it('finds no idea in a changelog without an entry', () => {
    expect(changelogIdea('# Changelog\n\nNothing yet.\n')).toBeNull();
    expect(changelogIdea('## v1\n\nprose only\n\n## v0\n\n- older\n')).toBeNull();
  });
});
