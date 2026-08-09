import { describe, expect, it } from 'vitest';
import {
  MEMORY_BODY_MAX,
  MEMORY_DESCRIPTION_MAX,
  MemoryFrontmatter,
  MemoryWriteArgs,
  buildMemorySpec,
  renderMemory,
  type MemoryDefinition
} from '../agent-memory';

const entry = (over: Partial<MemoryDefinition> = {}): MemoryDefinition => ({
  name: 'sqlite-abi',
  description: 'Run `npm test`, never `npx vitest run`, after the dev server has been up.',
  body: 'The sqlite addon is rebuilt for Electron by `npm run dev`.',
  source: 'project',
  path: '/repo/.fleet/memory/sqlite-abi.md',
  ...over
});

describe('MemoryFrontmatter', () => {
  it('reads a name and a description', () => {
    const parsed = MemoryFrontmatter.parse({ name: 'sqlite-abi', description: 'A thing.' });
    expect(parsed.name).toBe('sqlite-abi');
  });

  // Strict, unlike a skill's. Nothing else writes this format, so a field
  // nobody put there on purpose is a bug in whatever wrote the file.
  it('rejects a field nothing here would have written', () => {
    const parsed = MemoryFrontmatter.safeParse({
      name: 'sqlite-abi',
      description: 'A thing.',
      confidence: 0.8
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a name that is not a filename', () => {
    for (const name of ['../escape', 'Has Spaces', 'trailing-', 'UPPER']) {
      expect(MemoryFrontmatter.safeParse({ name, description: 'A thing.' }).success).toBe(false);
    }
  });

  it('rejects a description longer than the cap it rides on every round with', () => {
    const parsed = MemoryFrontmatter.safeParse({
      name: 'wordy',
      description: 'x'.repeat(MEMORY_DESCRIPTION_MAX + 1)
    });
    expect(parsed.success).toBe(false);
  });
});

describe('MemoryWriteArgs', () => {
  const args = {
    name: 'sqlite-abi',
    description: 'A thing.',
    body: 'The fact.',
    scope: 'project'
  };

  it('takes a name, a description, a body and a tier', () => {
    expect(MemoryWriteArgs.parse(args).scope).toBe('project');
  });

  // Which tier a fact lands in is consequential enough that the model has to
  // say, rather than have this file guess on its behalf.
  it('requires the tier rather than defaulting it', () => {
    const without = { ...args, scope: undefined };
    expect(MemoryWriteArgs.safeParse(without).success).toBe(false);
  });

  it('rejects a body long enough to be a procedure rather than a fact', () => {
    expect(
      MemoryWriteArgs.safeParse({ ...args, body: 'x'.repeat(MEMORY_BODY_MAX + 1) }).success
    ).toBe(false);
  });
});

describe('buildMemorySpec', () => {
  it('puts the roster in the description and the names in an enum', () => {
    const spec = buildMemorySpec([
      entry(),
      entry({ name: 'lint-red', description: 'Lint is red.' })
    ]);
    expect(spec?.function.description).toContain('`sqlite-abi`');
    expect(spec?.function.description).toContain('Lint is red.');
    expect(spec?.function.parameters).toMatchObject({
      properties: { name: { enum: ['sqlite-abi', 'lint-red'] } }
    });
  });

  // The read tool follows `skill`'s rule: with nothing to read there is nothing
  // to read. `memory_write` deliberately does not - it is how the first entry
  // comes to exist - and that pair is asserted in agent-tools.test.ts.
  it('is not offered when nothing has been recorded', () => {
    expect(buildMemorySpec([])).toBeNull();
  });
});

describe('renderMemory', () => {
  it('frames the note as a note rather than as an instruction', () => {
    const rendered = renderMemory(entry());
    expect(rendered).toContain('"sqlite-abi"');
    expect(rendered).toContain('not the user speaking');
    expect(rendered).toContain('The sqlite addon is rebuilt');
  });

  it('says which tier it came from', () => {
    expect(renderMemory(entry({ source: 'user' }))).toContain('between projects');
    expect(renderMemory(entry({ source: 'project' }))).toContain('against this project');
  });
});
