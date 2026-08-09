import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemorySource } from '../../../../shared/agent-memory';
import { loadFrom } from '../definitions';

const made: string[] = [];

/** A memory folder, where each key is a filename and each value its contents. */
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-memory-'));
  made.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

/** One well-formed entry. */
function file(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

async function from(...sources: Array<[MemorySource, string]>): ReturnType<typeof loadFrom> {
  return loadFrom(sources);
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadFrom', () => {
  it('reads name, description and body, and says which tier it came from', async () => {
    const dir = dirWith({ 'sqlite-abi.md': file('sqlite-abi', 'The addon ABI.', 'Run npm test.') });
    const [entry] = await from(['user', dir]);
    expect(entry).toMatchObject({
      name: 'sqlite-abi',
      description: 'The addon ABI.',
      body: 'Run npm test.',
      source: 'user'
    });
  });

  it('is empty for a folder nobody has made', async () => {
    expect(await from(['project', join(tmpdir(), 'fleet-memory-does-not-exist')])).toEqual([]);
  });

  // The repo gets to correct something the user believed in general.
  it('lets a project entry win a name the user also has', async () => {
    const user = dirWith({ 'lint.md': file('lint', 'Lint is clean.', 'It is clean.') });
    const project = dirWith({ 'lint.md': file('lint', 'Lint is red here.', 'It is red.') });
    const entries = await from(['user', user], ['project', project]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ description: 'Lint is red here.', source: 'project' });
  });

  it('skips a file whose frontmatter will not parse and keeps the ones beside it', async () => {
    const dir = dirWith({
      'broken.md': '---\nname: broken\n---\n\nNo description.\n',
      'fine.md': file('fine', 'A thing.', 'The thing.')
    });
    const entries = await from(['user', dir]);
    expect(entries.map((e) => e.name)).toEqual(['fine']);
  });

  // Without this, `memory_write({name: 'foo'})` and a hand-written file saying
  // `name: foo` would both claim `foo` and `readdir` order would decide.
  it('skips a file whose name disagrees with its filename', async () => {
    const dir = dirWith({ 'notes.md': file('foo', 'A thing.', 'The thing.') });
    expect(await from(['user', dir])).toEqual([]);
  });

  it('ignores anything that is not markdown', async () => {
    const dir = dirWith({
      'notes.txt': file('notes', 'A thing.', 'The thing.'),
      'real.md': file('real', 'A thing.', 'The thing.')
    });
    expect((await from(['user', dir])).map((e) => e.name)).toEqual(['real']);
  });
});
