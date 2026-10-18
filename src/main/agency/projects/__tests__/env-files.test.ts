import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectSetup } from '../../../../shared/agency-projects';
import type { GitRun } from '../../repo-identity';
import { copyEnvFiles, envNames, envSecrets, envValues, findEnvFiles } from '../env-files';
import { git, initRepo, tempDir, writeFiles } from './git-fixture';

/** Git with no global config, so the user's own ignore file cannot change what is ignored. */
const run: GitRun = async (args, cwd) => {
  try {
    return await Promise.resolve(git(cwd, ...args));
  } catch {
    return null;
  }
};

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir('fleet-env-files-');
});
afterEach(() => tmp.cleanup());

const setupWith = (envFiles: string[], path = '.'): ProjectSetup => ({
  version: 1,
  kind: 'repo',
  name: 'api',
  members: [
    {
      name: 'api',
      path,
      remote: null,
      defaultBranch: 'main',
      stack: [],
      packageManager: null,
      setupCommand: '',
      setupTimeoutSec: 600,
      checkCommands: [],
      checks: [],
      requiredChecks: [],
      reviewBots: [],
      portVars: [],
      fixedPorts: [],
      envFiles
    }
  ],
  imports: [],
  setupCommand: '',
  setupTimeoutSec: 600,
  stackSlots: null
});

describe('envNames and envValues', () => {
  const text = [
    '# a comment',
    'export API_KEY="sk live 123"',
    "DB_URL='postgres://u:p@h/db' # trailing",
    'PLAIN=abc # note',
    'EMPTY=',
    'API_KEY=again',
    'not an assignment'
  ].join('\n');

  it('reads each variable once, and each value without its quotes or comment', () => {
    expect(envNames(text)).toEqual(['API_KEY', 'DB_URL', 'PLAIN', 'EMPTY']);
    expect(envValues(text)).toEqual(['sk live 123', 'postgres://u:p@h/db', 'abc', 'again']);
  });
});

describe('findEnvFiles', () => {
  it('lists untracked env files with their names only, and says which ones git ignores', async () => {
    const root = initRepo(join(tmp.dir, 'api'), {
      '.gitignore': '.env\n.env.local\nnode_modules/\n',
      '.env.example': 'API_KEY=\n'
    });
    writeFiles(root, {
      '.env': 'API_KEY=secret\nDB_URL=x\n',
      '.env.local': 'DEBUG=1\n',
      '.env.test': 'TOKEN=t\n',
      'node_modules/pkg/.env': 'NOPE=1\n'
    });

    expect(await findEnvFiles(root, 'api', run)).toEqual([
      { member: 'api', path: '.env', vars: ['API_KEY', 'DB_URL'], ignored: true },
      { member: 'api', path: '.env.local', vars: ['DEBUG'], ignored: true },
      { member: 'api', path: '.env.test', vars: ['TOKEN'], ignored: false }
    ]);
  });
});

describe('copyEnvFiles', () => {
  it('refuses a path in the worktree that goes through a symlink', async () => {
    const from = initRepo(join(tmp.dir, 'api'), { '.gitignore': 'config/\n' });
    writeFiles(from, { 'config/.env': 'A=1\n' });
    const worktree = join(tmp.dir, 'wt');
    mkdirSync(join(tmp.dir, 'elsewhere'));
    git(from, 'worktree', 'add', '-q', '--detach', worktree);
    symlinkSync(join(tmp.dir, 'elsewhere'), join(worktree, 'config'));

    await expect(
      copyEnvFiles(setupWith(['config/.env']), [{ member: 'api', path: worktree, from }], run)
    ).rejects.toThrow('Not copying config/.env through config: it is a symlink.');
  });

  it('refuses a chosen file that is gone from the checkout', async () => {
    const from = initRepo(join(tmp.dir, 'api'), { '.gitignore': '.env\n' });
    const worktree = join(tmp.dir, 'wt');
    git(from, 'worktree', 'add', '-q', '--detach', worktree);

    await expect(
      copyEnvFiles(setupWith(['.env']), [{ member: 'api', path: worktree, from }], run)
    ).rejects.toThrow(".env is not in api's checkout any more.");
  });
});

describe('envSecrets', () => {
  it("reads the values of the chosen files only, from each member's main checkout", async () => {
    const root = join(tmp.dir, 'umbrella');
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api', '.env'), 'API_KEY=sk_live_1\n');
    writeFileSync(join(root, 'api', '.env.local'), 'OTHER=never\n');

    expect(
      await envSecrets(setupWith(['.env'], 'api'), [{ name: 'api', root: join(root, 'api') }])
    ).toEqual(['sk_live_1']);
  });
});
