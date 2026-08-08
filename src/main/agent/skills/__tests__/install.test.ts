import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Installing a skill, and knowing what is already installed.
 *
 * The home directory is faked for the whole file, because everything here reads
 * or writes `~/.fleet/skills` and `~/.claude/skills` - a test that used the real
 * one would report on whatever the person running it happens to have, and the
 * install tests would write into their home.
 */
const HOME = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'fleet-skills-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => HOME };
});

const { installSkills, listInstalled, removeSkill } = await import('../install');
const { detectSkills, scanRoots } = await import('../scan');

const FLEET_SKILLS = join(HOME, '.fleet', 'skills');
const CLAUDE_SKILLS = join(HOME, '.claude', 'skills');
/** A working folder that is not the home folder, so the two scopes stay apart. */
const PROJECT = join(HOME, 'project');

const skillMd = (name: string, body = 'Do the thing.'): string =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when doing ${name}.\n---\n${body}\n`;

/** A skill folder under `root`, with any extra files it bundles. */
function makeSkill(root: string, name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), files['SKILL.md'] ?? skillMd(name));
  for (const [path, contents] of Object.entries(files)) {
    if (path === 'SKILL.md') continue;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

afterEach(() => {
  for (const name of ['.fleet', '.claude', '.agents', 'project', 'elsewhere']) {
    rmSync(join(HOME, name), { recursive: true, force: true });
  }
});

/** Every folder the scan would offer, which is what install checks against. */
const offered = (): string[] => scanRoots(PROJECT).map((root) => root.dir);

describe('installSkills', () => {
  it('copies the whole folder, not only SKILL.md', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it', {
      'scripts/check.sh': 'echo hi',
      'references/API.md': '# API'
    });

    const outcome = await installSkills([{ name: 'ship-it', path: from }], offered());

    expect(outcome).toEqual({ installed: ['ship-it'], failed: [] });
    expect(readFileSync(join(FLEET_SKILLS, 'ship-it', 'scripts', 'check.sh'), 'utf8')).toBe(
      'echo hi'
    );
    expect(existsSync(join(FLEET_SKILLS, 'ship-it', 'references', 'API.md'))).toBe(true);
  });

  // What arrives here came from the renderer, and "copy this directory into the
  // user's home" is not an instruction to carry out on an arbitrary one.
  it('refuses a folder no scan offered', async () => {
    const from = makeSkill(join(HOME, 'elsewhere'), 'ship-it');

    const outcome = await installSkills([{ name: 'ship-it', path: from }], offered());

    expect(outcome.installed).toEqual([]);
    expect(outcome.failed[0].reason).toContain('not one Fleet offered');
    expect(existsSync(join(FLEET_SKILLS, 'ship-it'))).toBe(false);
  });

  it('refuses a folder reached by walking up out of a root', async () => {
    makeSkill(CLAUDE_SKILLS, 'ship-it');

    const outcome = await installSkills(
      [{ name: 'ship-it', path: join(CLAUDE_SKILLS, '..', '..', '.ssh') }],
      offered()
    );

    expect(outcome.failed).toHaveLength(1);
  });

  // The folder name is what the skill will be called; taking it from the path
  // means the renderer cannot ask for one to land under a different name.
  it('refuses when the name and the folder disagree', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it');

    const outcome = await installSkills([{ name: 'something-else', path: from }], offered());

    expect(outcome.failed[0].reason).toContain('disagree');
  });

  it('refuses a folder with no SKILL.md', async () => {
    const dir = join(CLAUDE_SKILLS, 'empty');
    mkdirSync(dir, { recursive: true });

    const outcome = await installSkills([{ name: 'empty', path: dir }], offered());

    expect(outcome.failed[0].reason).toContain('no SKILL.md');
  });

  // A user who ticked three and can have two wants the two.
  it('installs what it can and names what it could not', async () => {
    const good = makeSkill(CLAUDE_SKILLS, 'ship-it');
    const bad = makeSkill(join(HOME, 'elsewhere'), 'sneaky');

    const outcome = await installSkills(
      [
        { name: 'ship-it', path: good },
        { name: 'sneaky', path: bad }
      ],
      offered()
    );

    expect(outcome.installed).toEqual(['ship-it']);
    expect(outcome.failed.map((f) => f.name)).toEqual(['sneaky']);
  });

  // A merge would leave files from the old version beside the new one, with
  // nothing in the body mentioning them and nobody thinking to delete them.
  it('replaces the previous copy rather than merging into it', async () => {
    const first = makeSkill(CLAUDE_SKILLS, 'ship-it', { 'references/OLD.md': 'gone' });
    await installSkills([{ name: 'ship-it', path: first }], offered());
    rmSync(join(CLAUDE_SKILLS, 'ship-it'), { recursive: true, force: true });
    const second = makeSkill(CLAUDE_SKILLS, 'ship-it', { 'references/NEW.md': 'here' });

    await installSkills([{ name: 'ship-it', path: second }], offered());

    expect(existsSync(join(FLEET_SKILLS, 'ship-it', 'references', 'OLD.md'))).toBe(false);
    expect(existsSync(join(FLEET_SKILLS, 'ship-it', 'references', 'NEW.md'))).toBe(true);
  });

  it('leaves the repository metadata behind', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it', { '.git/config': '[core]' });

    await installSkills([{ name: 'ship-it', path: from }], offered());

    expect(existsSync(join(FLEET_SKILLS, 'ship-it', '.git'))).toBe(false);
  });
});

describe('listInstalled', () => {
  it('reports what Fleet holds, with the folder rather than the file', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it');
    await installSkills([{ name: 'ship-it', path: from }], offered());

    expect(await listInstalled()).toEqual([
      {
        name: 'ship-it',
        description: 'Does ship-it. Use when doing ship-it.',
        path: join(FLEET_SKILLS, 'ship-it')
      }
    ]);
  });

  it('is empty before anything is installed', async () => {
    expect(await listInstalled()).toEqual([]);
  });
});

describe('removeSkill', () => {
  it('deletes the folder it holds', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it');
    await installSkills([{ name: 'ship-it', path: from }], offered());

    await removeSkill('ship-it');

    expect(existsSync(join(FLEET_SKILLS, 'ship-it'))).toBe(false);
  });

  // Rebuilt from the name rather than taken as a path, so the worst a bad name
  // can do is fail to match a folder.
  it('refuses a name that is really a path', async () => {
    await expect(removeSkill('../../.ssh')).rejects.toThrow('is not a skill name');
  });
});

describe('detectSkills', () => {
  it('marks one Fleet does not have as new', async () => {
    makeSkill(CLAUDE_SKILLS, 'ship-it');

    const [found] = await detectSkills(PROJECT);

    expect(found).toMatchObject({
      name: 'ship-it',
      status: 'new',
      origin: { foundIn: 'claude-code', scope: 'user', root: CLAUDE_SKILLS }
    });
  });

  it('marks one already installed as known', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it');
    await installSkills([{ name: 'ship-it', path: from }], offered());

    const [found] = await detectSkills(PROJECT);

    expect(found.status).toBe('known');
  });

  // Deliberately not saying which side moved: Fleet's copy is meant to be able
  // to drift, so an edited copy and a new upstream version are the same answer.
  it('marks one whose text has moved as changed', async () => {
    const from = makeSkill(CLAUDE_SKILLS, 'ship-it');
    await installSkills([{ name: 'ship-it', path: from }], offered());
    writeFileSync(join(from, 'SKILL.md'), skillMd('ship-it', 'Do it differently now.'));

    const [found] = await detectSkills(PROJECT);

    expect(found.status).toBe('changed');
  });

  // Two tools both having a `commit-style` is ordinary, and which one is wanted
  // is a question only the user can answer.
  it('offers the same name from two roots rather than picking one', async () => {
    makeSkill(CLAUDE_SKILLS, 'ship-it');
    makeSkill(join(HOME, '.agents', 'skills'), 'ship-it');

    const found = await detectSkills(PROJECT);

    expect(found.map((f) => f.origin.foundIn)).toEqual(['claude-code', 'agents']);
  });

  // What is in Fleet's own folder is already loaded; offering it back would be a
  // list of things to import that the user has already imported.
  it('does not scan Fleet’s own folder', async () => {
    makeSkill(FLEET_SKILLS, 'ship-it');

    expect(await detectSkills(PROJECT)).toEqual([]);
  });
});
