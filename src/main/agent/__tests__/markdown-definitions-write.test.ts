import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseDefinitionFile } from '../markdown-definitions';
import { writeFrontmatterFile } from '../markdown-definitions-write';

/**
 * Held through `vi.hoisted` because the factory below is lifted above the
 * imports, so an ordinary `const` would not exist yet when it runs.
 */
const state = vi.hoisted(() => ({ failRename: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  return {
    ...real,
    rename: async (from: string, to: string): Promise<void> => {
      if (state.failRename) throw new Error('rename failed');
      return real.rename(from, to);
    }
  };
});

const Frontmatter = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1).max(200)
});

const made: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-write-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  state.failRename = false;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeFrontmatterFile', () => {
  it('writes a file the reader parses back to what went in', async () => {
    const path = join(folder(), 'a-note.md');
    await writeFrontmatterFile(
      path,
      { name: 'a-note', description: 'A thing worth knowing.' },
      'The thing.',
      Frontmatter,
      'memory'
    );

    const parsed = parseDefinitionFile(readFileSync(path, 'utf8'), Frontmatter, 'memory');
    expect(parsed).toMatchObject({
      ok: true,
      frontmatter: { name: 'a-note', description: 'A thing worth knowing.' },
      body: 'The thing.'
    });
  });

  /*
   * The bug this whole file exists for, from
   * docs/learnings/2026-04-28-pi-skill-frontmatter-yaml.md. A colon and a space
   * inside a value ends the key early in hand-built YAML, and the file that
   * results looks entirely reasonable.
   */
  it('survives a description containing ": "', async () => {
    const path = join(folder(), 'colon.md');
    const description = 'Use when: the build fails with "error: no such file".';
    await writeFrontmatterFile(
      path,
      { name: 'colon', description },
      'Body.',
      Frontmatter,
      'memory'
    );

    const parsed = parseDefinitionFile(readFileSync(path, 'utf8'), Frontmatter, 'memory');
    expect(parsed).toMatchObject({ ok: true, frontmatter: { description } });
  });

  it('survives a description that is nothing but YAML punctuation', async () => {
    const path = join(folder(), 'punctuation.md');
    const description = '- {a: [b]} | > # & * ! % @ `';
    await writeFrontmatterFile(
      path,
      { name: 'punctuation', description },
      'Body.',
      Frontmatter,
      'memory'
    );
    expect(parseDefinitionFile(readFileSync(path, 'utf8'), Frontmatter, 'memory')).toMatchObject({
      ok: true,
      frontmatter: { description }
    });
  });

  it('throws before touching disk when what it built would not read back', async () => {
    const dir = folder();
    await expect(
      writeFrontmatterFile(
        join(dir, 'bad.md'),
        { name: 'Not A Name', description: 'A thing.' },
        'Body.',
        Frontmatter,
        'memory'
      )
    ).rejects.toThrow(/will not read back/);
    // Not the file, and not a temp file either.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves the previous file whole when the rename fails', async () => {
    const path = join(folder(), 'existing.md');
    writeFileSync(path, '---\nname: existing\ndescription: The old one.\n---\n\nOld body.\n');

    state.failRename = true;
    await expect(
      writeFrontmatterFile(
        path,
        { name: 'existing', description: 'The new one.' },
        'New body.',
        Frontmatter,
        'memory'
      )
    ).rejects.toThrow('rename failed');

    expect(readFileSync(path, 'utf8')).toContain('Old body.');
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('creates the folder when it is not there yet', async () => {
    const path = join(folder(), 'nested', 'deeper', 'note.md');
    await writeFrontmatterFile(
      path,
      { name: 'note', description: 'A thing.' },
      'Body.',
      Frontmatter,
      'memory'
    );
    expect(existsSync(path)).toBe(true);
  });
});
