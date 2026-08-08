import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFrom } from '../definitions';

/** The commands this repo ships, from a path only the source tree moves. */
const SHIPPED_DIR = fileURLToPath(new URL('../../../../../resources/commands', import.meta.url));

const made: string[] = [];

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-commands-'));
  made.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VALID = `---
name: ship-it
description: Ships it.
---
Ship the thing.
`;

describe('loadFrom', () => {
  it('reads the name, the description and the prompt below them', async () => {
    const [found] = await loadFrom([['user', dirWith({ 'ship-it.md': VALID })]]);
    expect(found).toMatchObject({
      name: 'ship-it',
      description: 'Ships it.',
      template: 'Ship the thing.',
      source: 'user'
    });
  });

  // The name in the file wins over the name of the file, so renaming one does
  // not quietly rename the command.
  it('takes the name from the frontmatter rather than the filename', async () => {
    const [found] = await loadFrom([['user', dirWith({ 'anything.md': VALID })]]);
    expect(found.name).toBe('ship-it');
  });

  it('lets a later source override a name an earlier one used', async () => {
    const found = await loadFrom([
      ['bundled', dirWith({ 'a.md': '---\nname: a\ndescription: bundled\n---\nold' })],
      ['project', dirWith({ 'a.md': '---\nname: a\ndescription: project\n---\nnew' })]
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ description: 'project', template: 'new', source: 'project' });
  });

  // The one thing a file may not do. `/clear` never reaches the model, so a
  // file that took the name would stop it clearing anything.
  it('refuses a file that would shadow a builtin', async () => {
    const found = await loadFrom([
      ['project', dirWith({ 'clear.md': '---\nname: clear\ndescription: d\n---\nprompt' })]
    ]);
    expect(found).toEqual([]);
  });

  it('skips a file that is not a definition rather than failing the folder', async () => {
    const found = await loadFrom([
      [
        'user',
        dirWith({
          'good.md': VALID,
          'no-fence.md': 'just some notes',
          'bad-yaml.md': '---\nname: [\n---\nprompt',
          'bad-name.md': '---\nname: Ship It\ndescription: d\n---\nprompt',
          'no-description.md': '---\nname: nodesc\n---\nprompt',
          'empty-body.md': '---\nname: empty\ndescription: d\n---\n',
          'notes.txt': VALID
        })
      ]
    ]);
    expect(found.map((c) => c.name)).toEqual(['ship-it']);
  });

  it('is empty for a folder nobody has made', async () => {
    expect(await loadFrom([['project', join(tmpdir(), 'fleet-not-a-folder-at-all')]])).toEqual([]);
  });

  it('sorts by name, so the menu does not reorder itself', async () => {
    const found = await loadFrom([
      [
        'user',
        dirWith({
          'b.md': '---\nname: b\ndescription: d\n---\np',
          'a.md': '---\nname: a\ndescription: d\n---\np',
          'c.md': '---\nname: c\ndescription: d\n---\np'
        })
      ]
    ]);
    expect(found.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * The ones that ship. Read from the repo rather than through the production
 * path resolver, which is arithmetic against the bundle and cannot be checked
 * from here - see the learning that came out of getting exactly that wrong.
 */
describe('the commands Fleet ships', () => {
  it('all parse', async () => {
    const found = await loadFrom([['bundled', SHIPPED_DIR]]);
    expect(found.length).toBeGreaterThan(0);
    for (const command of found) {
      expect(command.description).not.toBe('');
      expect(command.template).not.toBe('');
    }
  });

  it('includes pr-review', async () => {
    const found = await loadFrom([['bundled', SHIPPED_DIR]]);
    expect(found.map((c) => c.name)).toContain('pr-review');
  });
});
