import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import type * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryWriteArgsFields } from '../../../../shared/agent-memory';
import { forgetAllFiles, remember } from '../../tools/freshness';
import { writeMemoryEntry } from '../write';

/** A home directory of its own, so the user tier is testable without touching one. */
const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof os>();
  return { ...real, homedir: (): string => home.dir };
});

const made: string[] = [];

/**
 * Symlinks resolved, because everything on the write path goes through
 * `resolveInsideCwd` and so records freshness against the real path. On macOS
 * `/var/folders` is a link to `/private/var/folders`, and a test that remembered
 * the unresolved path would fail the guard for the wrong reason.
 */
function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

const THREAD = 'thread-1';

const args = (over: Partial<MemoryWriteArgsFields> = {}): MemoryWriteArgsFields => ({
  name: 'sqlite-abi',
  description: 'Run npm test, not npx vitest run.',
  body: 'The addon is rebuilt for Electron by the dev server.',
  scope: 'project',
  ...over
});

beforeEach(() => {
  forgetAllFiles();
  home.dir = folder('fleet-home-');
});

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('writeMemoryEntry', () => {
  it('creates an entry with nothing read first, and says where it went', async () => {
    const cwd = folder('fleet-cwd-');
    const result = await writeMemoryEntry(args(), { cwd, threadId: THREAD });

    expect(result.summary).toBe('recorded');
    const path = join(cwd, '.fleet', 'memory', 'sqlite-abi.md');
    expect(readFileSync(path, 'utf8')).toContain('The addon is rebuilt');
  });

  it('writes a user-tier entry outside the working folder', async () => {
    const cwd = folder('fleet-cwd-');
    await writeMemoryEntry(args({ scope: 'user' }), { cwd, threadId: THREAD });

    expect(existsSync(join(home.dir, '.fleet', 'memory', 'sqlite-abi.md'))).toBe(true);
    expect(existsSync(join(cwd, '.fleet', 'memory', 'sqlite-abi.md'))).toBe(false);
  });

  // The same guard `write` puts on replacing a file. A model that has not read
  // the entry does not know what it is about to throw away.
  it('refuses to replace an entry this conversation has not read', async () => {
    const cwd = folder('fleet-cwd-');
    await writeMemoryEntry(args(), { cwd, threadId: THREAD });
    forgetAllFiles();

    await expect(
      writeMemoryEntry(args({ body: 'Something else.' }), { cwd, threadId: THREAD })
    ).rejects.toThrow(/Read the "sqlite-abi" memory before changing it/);
  });

  it('replaces one it has read, and reports the diff', async () => {
    const cwd = folder('fleet-cwd-');
    const path = join(cwd, '.fleet', 'memory', 'sqlite-abi.md');
    mkdirSync(join(cwd, '.fleet', 'memory'), { recursive: true });
    writeFileSync(path, '---\nname: sqlite-abi\ndescription: An old line.\n---\n\nThe old fact.\n');
    remember(THREAD, path, statSync(path));

    const result = await writeMemoryEntry(args(), { cwd, threadId: THREAD });
    expect(result.summary).toMatch(/^\+\d+ -\d+$/);
    expect(result.text).toContain('The old fact.');
    expect(readFileSync(path, 'utf8')).toContain('The addon is rebuilt');
  });

  // Writing a file is knowing what is in it, so correcting the same entry twice
  // in one turn does not need a read wedged in between.
  it('lets a second write in the same turn follow the first', async () => {
    const cwd = folder('fleet-cwd-');
    await writeMemoryEntry(args(), { cwd, threadId: THREAD });
    const again = await writeMemoryEntry(args({ body: 'Corrected.' }), {
      cwd,
      threadId: THREAD
    });
    expect(again.summary).toMatch(/^\+\d+ -\d+$/);
  });

  // Freshness is per conversation, so one pane's reading cannot vouch for
  // another pane's rewrite.
  it('does not let one conversation license another conversation’s rewrite', async () => {
    const cwd = folder('fleet-cwd-');
    await writeMemoryEntry(args(), { cwd, threadId: THREAD });
    await expect(
      writeMemoryEntry(args({ body: 'Other pane.' }), { cwd, threadId: 'thread-2' })
    ).rejects.toThrow(/before changing it/);
  });

  it('writes something the loader will read back', async () => {
    const cwd = folder('fleet-cwd-');
    await writeMemoryEntry(
      args({ description: 'Use when: the build says "error: no such file".' }),
      { cwd, threadId: THREAD }
    );
    const { loadFrom } = await import('../definitions');
    const entries = await loadFrom([['project', join(cwd, '.fleet', 'memory')]]);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('Use when: the build says "error: no such file".');
  });
});
