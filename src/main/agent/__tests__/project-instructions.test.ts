import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectInstructions } from '../project-instructions';

const made: string[] = [];

/** A working folder holding the named files. */
function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-instructions-'));
  made.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadProjectInstructions', () => {
  it('returns null when the folder has neither file', async () => {
    expect(await loadProjectInstructions(folderWith({}))).toBeNull();
  });

  it('reads CLAUDE.md when that is the only one there', async () => {
    const found = await loadProjectInstructions(folderWith({ 'CLAUDE.md': 'House style.' }));
    expect(found?.filename).toBe('CLAUDE.md');
    expect(found?.text).toBe('House style.');
  });

  // No merge. The project already decided by having both, and the shared-format
  // file is the one it wrote for agents in general.
  it('prefers AGENTS.md outright when both exist', async () => {
    const found = await loadProjectInstructions(
      folderWith({ 'AGENTS.md': 'The standard one.', 'CLAUDE.md': 'The other one.' })
    );
    expect(found?.filename).toBe('AGENTS.md');
    expect(found?.text).toBe('The standard one.');
    expect(found?.text).not.toContain('The other one.');
  });

  // A placeholder somebody committed is not a decision to have no instructions.
  it('falls through an empty AGENTS.md rather than letting it shadow CLAUDE.md', async () => {
    const found = await loadProjectInstructions(
      folderWith({ 'AGENTS.md': '\n  \n', 'CLAUDE.md': 'House style.' })
    );
    expect(found?.filename).toBe('CLAUDE.md');
  });

  it('reports what the file costs', async () => {
    const found = await loadProjectInstructions(folderWith({ 'AGENTS.md': 'x'.repeat(3_500) }));
    expect(found?.tokens).toBe(1_000);
  });

  // Requirement 5, at the loader. The prompt-level assertion is in
  // `agent-service.test.ts`, because the regression to fear is a cap added
  // later somewhere between here and there.
  it('returns a very large file whole', async () => {
    const huge = 'x'.repeat(200_000);
    const found = await loadProjectInstructions(folderWith({ 'AGENTS.md': huge }));
    expect(found?.text).toHaveLength(200_000);
    expect(found?.text).toBe(huge);
  });
});
