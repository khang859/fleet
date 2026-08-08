import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFrom } from '../definitions';

/** The skills this repo ships, from a path only the source tree moves. */
const SHIPPED_DIR = fileURLToPath(new URL('../../../../../resources/skills', import.meta.url));

const made: string[] = [];

/** A skills folder, where each key is a skill name and each value its SKILL.md. */
function dirWith(skills: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-skills-'));
  made.push(dir);
  for (const [name, contents] of Object.entries(skills)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VALID = `---
name: ship-it
description: Ships it. Use when shipping.
---
Ship the thing, carefully.
`;

describe('loadFrom', () => {
  it('reads the name, the description and the body below them', async () => {
    const dir = dirWith({ 'ship-it': VALID });
    const [found] = await loadFrom([['user', dir]]);
    expect(found).toMatchObject({
      name: 'ship-it',
      description: 'Ships it. Use when shipping.',
      body: 'Ship the thing, carefully.',
      source: 'user',
      dir: join(dir, 'ship-it')
    });
  });

  // Every path a skill mentions is relative to its own folder, so the folder is
  // what the model has to be told - not the file and not the working folder.
  it('reports the folder holding SKILL.md, not the file', async () => {
    const dir = dirWith({ 'ship-it': VALID });
    const [found] = await loadFrom([['user', dir]]);
    expect(found.dir).toBe(join(dir, 'ship-it'));
    expect(found.path).toBe(join(dir, 'ship-it', 'SKILL.md'));
  });

  // The spec requires it, and without it two folders could claim one name and
  // the second would silently replace the first.
  it('refuses a skill whose name disagrees with its folder', async () => {
    const found = await loadFrom([
      ['user', dirWith({ elsewhere: '---\nname: ship-it\ndescription: d\n---\nbody' })]
    ]);
    expect(found).toEqual([]);
  });

  it('lets a later source override a name an earlier one used', async () => {
    const found = await loadFrom([
      ['bundled', dirWith({ a: '---\nname: a\ndescription: bundled\n---\nold' })],
      ['project', dirWith({ a: '---\nname: a\ndescription: project\n---\nnew' })]
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ description: 'project', body: 'new', source: 'project' });
  });

  it('skips a folder that is not a skill rather than failing the folder', async () => {
    const found = await loadFrom([
      [
        'user',
        dirWith({
          'ship-it': VALID,
          'no-fence': 'just some notes',
          'bad-yaml': '---\nname: [\n---\nbody',
          'bad-name': '---\nname: Ship It\ndescription: d\n---\nbody',
          'no-description': '---\nname: no-description\n---\nbody',
          'empty-body': '---\nname: empty-body\ndescription: d\n---\n'
        })
      ]
    ]);
    expect(found.map((s) => s.name)).toEqual(['ship-it']);
  });

  // A folder with no SKILL.md is not a broken skill, it is not a skill. The one
  // that matters in practice is the flat fleet.md `installSkillFile` writes into
  // ~/.fleet/skills for agents running in Fleet terminals.
  it('ignores loose files and folders with no SKILL.md', async () => {
    const dir = dirWith({ 'ship-it': VALID });
    writeFileSync(join(dir, 'fleet.md'), '# not a skill\n');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'README.md'), 'nothing here');
    const found = await loadFrom([['user', dir]]);
    expect(found.map((s) => s.name)).toEqual(['ship-it']);
  });

  // How you keep a skill in a repo and use it from everywhere.
  it('follows a symlinked skill folder', async () => {
    const real = dirWith({ 'ship-it': VALID });
    const linked = mkdtempSync(join(tmpdir(), 'fleet-skills-link-'));
    made.push(linked);
    symlinkSync(join(real, 'ship-it'), join(linked, 'ship-it'), 'dir');
    const found = await loadFrom([['user', linked]]);
    expect(found.map((s) => s.name)).toEqual(['ship-it']);
  });

  // A field Claude Code understands and Fleet does not must not stop the file
  // loading, or adopting a shared format buys nothing.
  it('ignores frontmatter fields outside the spec', async () => {
    const found = await loadFrom([
      [
        'user',
        dirWith({
          forked: [
            '---',
            'name: forked',
            'description: d',
            'context: fork',
            'argument-hint: "[pr]"',
            'allowed-tools: Bash(git:*) Read',
            '---',
            'body'
          ].join('\n')
        })
      ]
    ]);
    expect(found.map((s) => s.name)).toEqual(['forked']);
  });

  it('is empty for a folder nobody has made', async () => {
    expect(await loadFrom([['project', join(tmpdir(), 'fleet-not-a-folder-at-all')]])).toEqual([]);
  });

  it('sorts by name, so the roster does not reorder itself', async () => {
    const found = await loadFrom([
      [
        'user',
        dirWith({
          b: '---\nname: b\ndescription: d\n---\np',
          a: '---\nname: a\ndescription: d\n---\np',
          c: '---\nname: c\ndescription: d\n---\np'
        })
      ]
    ]);
    expect(found.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * The ones that ship. Read from the repo rather than through the production
 * path resolver, which is arithmetic against the bundle and cannot be checked
 * from here - see the learning that came out of getting exactly that wrong.
 */
describe('the skills Fleet ships', () => {
  it('all parse', async () => {
    const found = await loadFrom([['bundled', SHIPPED_DIR]]);
    expect(found.length).toBeGreaterThan(0);
    for (const skill of found) {
      expect(skill.description).not.toBe('');
      expect(skill.body).not.toBe('');
    }
  });

  // Also the file `installSkillFile` copies to ~/.fleet/skills/fleet.md for
  // agents running in Fleet terminals. If this stops parsing, that copy is still
  // made but Fleet's own agent quietly loses it.
  it('includes fleet', async () => {
    const found = await loadFrom([['bundled', SHIPPED_DIR]]);
    expect(found.map((s) => s.name)).toContain('fleet');
  });
});
