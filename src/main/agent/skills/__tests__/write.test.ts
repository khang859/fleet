import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillWriteArgsFields } from '../../../../shared/agent-skills';
import { forgetAllFiles } from '../../tools/freshness';
import { loadFrom } from '../definitions';
import { writeSkillBody } from '../write';

const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof os>();
  return { ...real, homedir: (): string => home.dir };
});

const made: string[] = [];

/** Symlinks resolved, to match what the write path records freshness against. */
function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

const THREAD = 'thread-1';

const args = (over: Partial<SkillWriteArgsFields> = {}): SkillWriteArgsFields => ({
  name: 'release-check',
  description: 'Use before tagging a release.',
  body: '1. Update the changelog.\n2. Tag.',
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

describe('writeSkillBody', () => {
  it('writes a SKILL.md the skills loader reads back', async () => {
    const cwd = folder('fleet-cwd-');
    const result = await writeSkillBody(args(), { cwd, threadId: THREAD });
    expect(result.summary).toBe('written');

    const found = await loadFrom([['project', join(cwd, '.fleet', 'skills')]]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'release-check',
      description: 'Use before tagging a release.'
    });
    expect(found[0].body).toContain('Update the changelog');
  });

  it('writes a user-tier skill outside the working folder', async () => {
    const cwd = folder('fleet-cwd-');
    await writeSkillBody(args({ scope: 'user' }), { cwd, threadId: THREAD });
    expect(existsSync(join(home.dir, '.fleet', 'skills', 'release-check', 'SKILL.md'))).toBe(true);
  });

  // A skill is loaded as instructions on every later turn that matches it, so a
  // rewrite reaches further than a memory does. Reading it first is the guard.
  it('refuses to replace one this conversation has not read', async () => {
    const cwd = folder('fleet-cwd-');
    await writeSkillBody(args(), { cwd, threadId: THREAD });
    forgetAllFiles();

    await expect(
      writeSkillBody(args({ body: 'Something else entirely.' }), { cwd, threadId: THREAD })
    ).rejects.toThrow(/Read the "release-check" skill before changing it/);
  });

  it('reports a diff when it replaces one it wrote in this turn', async () => {
    const cwd = folder('fleet-cwd-');
    await writeSkillBody(args(), { cwd, threadId: THREAD });
    const again = await writeSkillBody(args({ body: '1. Do it differently.' }), {
      cwd,
      threadId: THREAD
    });
    expect(again.summary).toMatch(/^\+\d+ -\d+$/);
    expect(
      readFileSync(join(cwd, '.fleet', 'skills', 'release-check', 'SKILL.md'), 'utf8')
    ).toContain('differently');
  });
});
