import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDefinition } from '../../../../shared/agent-skills';
import type { AgentToolContext } from '../../../../shared/agent-tools';
import { runSkill } from '../skill';

/**
 * The `skill` tool.
 *
 * What matters here is the second job it does: serving files from inside the
 * skill's own folder. Every other path tool is confined to the working folder,
 * and a user or bundled skill is not in one - so this is the only place in the
 * agent where a file outside `cwd` is read, and the confinement it applies
 * instead is the thing worth testing.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill folder on disk, and the definition pointing at it. */
function skillWith(files: Record<string, string>): SkillDefinition {
  const root = mkdtempSync(join(tmpdir(), 'fleet-skill-tool-'));
  made.push(root);
  const dir = join(root, 'ship-it');
  for (const [name, contents] of Object.entries({ 'SKILL.md': 'body', ...files })) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), contents);
  }
  return {
    name: 'ship-it',
    description: 'Ships it.',
    body: 'Ship the thing, carefully.',
    dir,
    source: 'user',
    path: join(dir, 'SKILL.md')
  };
}

const ctx = (definition: SkillDefinition | null): AgentToolContext => ({
  cwd: mkdtempSync(join(tmpdir(), 'fleet-skill-cwd-')),
  threadId: '11111111-2222-4333-8444-555555555555',
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage: null,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: definition === null ? null : (name) => (name === definition.name ? definition : null),
  schedule: null,
  todos: { list: () => [], save: () => {} }
});

describe('skill', () => {
  it('answers with the body, and with what the folder bundles', async () => {
    const definition = skillWith({
      'references/API.md': '# API',
      'scripts/check.sh': 'echo hi'
    });
    const result = await runSkill({ name: 'ship-it' }, ctx(definition));
    expect(result.text).toContain('Ship the thing, carefully.');
    expect(result.text).toContain('references/API.md');
    expect(result.text).toContain('scripts/check.sh');
  });

  // Listing it invites a second call for the thing the model is already holding.
  it('leaves SKILL.md out of the listing', async () => {
    const result = await runSkill({ name: 'ship-it' }, ctx(skillWith({})));
    expect(result.text).not.toContain('SKILL.md');
  });

  it('refuses a name it does not have', async () => {
    await expect(runSkill({ name: 'nope' }, ctx(skillWith({})))).rejects.toThrow(
      'There is no skill called "nope".'
    );
  });

  it('refuses when the folder has no skills at all', async () => {
    await expect(runSkill({ name: 'ship-it' }, ctx(null))).rejects.toThrow('no skills');
  });

  it('reads a bundled file when asked for one', async () => {
    const definition = skillWith({ 'references/API.md': 'the whole API' });
    const result = await runSkill({ name: 'ship-it', file: 'references/API.md' }, ctx(definition));
    expect(result.text).toContain('the whole API');
    // A size, not the path: the path is on the row already, next to the verb.
    expect(result.summary).toBe('1 line');
  });

  // The point of the `file` parameter is that it widens nothing: it is the same
  // confinement the read tool applies, with the skill's folder as the root.
  it('refuses a path that climbs out of the skill', async () => {
    const definition = skillWith({});
    writeFileSync(join(definition.dir, '..', 'secret.txt'), 'not yours');
    await expect(
      runSkill({ name: 'ship-it', file: '../secret.txt' }, ctx(definition))
    ).rejects.toThrow('not inside the ship-it skill');
  });

  it('refuses a symlink that points out of the skill', async () => {
    const definition = skillWith({});
    writeFileSync(join(definition.dir, '..', 'secret.txt'), 'not yours');
    symlinkSync(join(definition.dir, '..', 'secret.txt'), join(definition.dir, 'link.txt'));
    await expect(runSkill({ name: 'ship-it', file: 'link.txt' }, ctx(definition))).rejects.toThrow(
      'not inside the ship-it skill'
    );
  });

  // The body is what tells the model which files exist, so a wrong guess is an
  // ordinary thing to do and the message says how to find the right one.
  it('says how to find the real files when asked for one that is not there', async () => {
    await expect(
      runSkill({ name: 'ship-it', file: 'references/nope.md' }, ctx(skillWith({})))
    ).rejects.toThrow('Load the skill without');
  });
});
