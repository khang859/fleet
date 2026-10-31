import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryDefinition } from '../../../../shared/agent-memory';
import type { AgentToolContext } from '../../../../shared/agent-tools';
import { writeMemoryEntry } from '../../memory/write';
import { forgetAllFiles } from '../freshness';
import { runMemoryRead } from '../memory';

/**
 * The `memory` tool.
 *
 * Two of these are the same shape as `skill`'s and are here because the errors
 * are what the model sees. The one that earns its place is the last: reading an
 * entry has to count as having read the file, or the ordinary sequence - notice
 * a note is wrong, correct it - costs a refusal in the middle.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  forgetAllFiles();
});

const THREAD = '11111111-2222-4333-8444-555555555555';

/** A project-tier entry on disk, in a working folder of its own. */
function recorded(body: string): { cwd: string; definition: MemoryDefinition } {
  const cwd = mkdtempSync(join(tmpdir(), 'fleet-memory-tool-'));
  made.push(cwd);
  const dir = join(cwd, '.fleet', 'memory');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sqlite-abi.md');
  writeFileSync(
    path,
    `---\nname: sqlite-abi\ndescription: How to run the tests.\n---\n\n${body}\n`
  );
  return {
    cwd,
    definition: {
      name: 'sqlite-abi',
      description: 'How to run the tests.',
      body,
      source: 'project',
      path
    }
  };
}

const ctx = (cwd: string, definition: MemoryDefinition | null): AgentToolContext => ({
  cwd,
  threadId: THREAD,
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage: null,
  fetchUrl: null,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: null,
  findMemory: definition === null ? null : (name) => (name === definition.name ? definition : null),
  schedule: null,
  todos: { list: () => [], save: () => {} }
});

describe('memory', () => {
  it('answers with the note, framed as something written down earlier', async () => {
    const { cwd, definition } = recorded('Run npm test, not npx vitest run.');
    const result = await runMemoryRead({ name: 'sqlite-abi' }, ctx(cwd, definition));
    expect(result.text).toContain('Run npm test, not npx vitest run.');
    expect(result.text).toContain('recorded against this project');
  });

  it('refuses a name it does not have', async () => {
    const { cwd, definition } = recorded('anything');
    await expect(runMemoryRead({ name: 'nope' }, ctx(cwd, definition))).rejects.toThrow(
      'There is no memory called "nope".'
    );
  });

  it('refuses when nothing has been recorded at all', async () => {
    const { cwd } = recorded('anything');
    await expect(runMemoryRead({ name: 'sqlite-abi' }, ctx(cwd, null))).rejects.toThrow(
      'Nothing has been recorded'
    );
  });

  // The one that is not obvious. `memory_write` applies the same freshness guard
  // `write` does, and its idea of the path comes through `resolveInsideCwd` -
  // so the read has to stamp the resolved path, not the one the definition
  // happens to carry.
  it('counts as having read the file, so the correction can follow it', async () => {
    const { cwd, definition } = recorded('The old fact.');
    await runMemoryRead({ name: 'sqlite-abi' }, ctx(cwd, definition));

    const result = await writeMemoryEntry(
      {
        name: 'sqlite-abi',
        description: 'How to run the tests.',
        body: 'The corrected fact.',
        scope: 'project'
      },
      { cwd, threadId: THREAD }
    );
    expect(result.text).toContain('The old fact.');
  });
});
