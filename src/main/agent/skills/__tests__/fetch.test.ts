import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as os from 'node:os';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Reading a checkout, without doing a clone to get one.
 *
 * The interesting part of fetching is the shapes a repository can have, not
 * `git clone`. Home is faked because the status on every row is decided by
 * comparing against `~/.fleet/skills`.
 */
const HOME = await vi.hoisted(async () => {
  const { mkdtempSync: make } = await import('node:fs');
  const { tmpdir: temp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return make(joinPath(temp(), 'fleet-fetch-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => HOME };
});

const { readCheckout } = await import('../fetch');

const skillMd = (name: string): string =>
  `---\nname: ${name}\ndescription: Does ${name}. Use when doing ${name}.\n---\nDo the thing.\n`;

const holders: string[] = [];

/** A holder folder with a `repo` checkout in it, laid out as `files` says. */
function checkout(files: Record<string, string>): { holder: string; dir: string } {
  const holder = mkdtempSync(join(tmpdir(), 'fleet-fetch-'));
  holders.push(holder);
  const dir = join(holder, 'repo');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return { holder, dir };
}

afterEach(() => {
  for (const holder of holders.splice(0)) rmSync(holder, { recursive: true, force: true });
  rmSync(join(HOME, '.fleet'), { recursive: true, force: true });
});

describe('readCheckout', () => {
  it('finds skills laid out at the top of the repository', async () => {
    const { holder, dir } = checkout({
      'ship-it/SKILL.md': skillMd('ship-it'),
      'review/SKILL.md': skillMd('review')
    });

    const read = await readCheckout(holder, dir, 'someone/skills');

    expect(read.found.map((f) => f.name).sort()).toEqual(['review', 'ship-it']);
  });

  it('finds skills under a skills/ folder', async () => {
    const { holder, dir } = checkout({ 'skills/ship-it/SKILL.md': skillMd('ship-it') });

    const read = await readCheckout(holder, dir, 'someone/skills');

    expect(read.found.map((f) => f.name)).toEqual(['ship-it']);
  });

  // A skill published as a repository of its own. The checkout directory *is*
  // the skill folder, and what git happened to clone it into says nothing about
  // what the skill is called - so it is renamed to the name in its frontmatter
  // before the loader, which requires the two to match, ever looks at it.
  it('finds a repository that is itself one skill', async () => {
    const { holder, dir } = checkout({
      'SKILL.md': skillMd('pdf-filler'),
      'references/API.md': '# API'
    });

    const read = await readCheckout(holder, dir, 'someone/pdf-filler');

    expect(read.found.map((f) => f.name)).toEqual(['pdf-filler']);
    expect(basename(read.dir)).toBe('pdf-filler');
    expect(read.found[0].origin.path).toBe(read.dir);
    // The holder is the root, so install's "is this a folder we offered" check
    // sees an ordinary child of an ordinary root.
    expect(read.roots).toContain(holder);
  });

  it('reports nothing for a repository with no skills in it', async () => {
    const { holder, dir } = checkout({ 'README.md': '# hello' });

    const read = await readCheckout(holder, dir, 'someone/not-skills');

    expect(read.found).toEqual([]);
  });
});
