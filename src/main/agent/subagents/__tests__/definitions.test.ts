import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFrom } from '../definitions';

/** The definitions this repo ships, from a path only the source tree moves. */
const SHIPPED_DIR = fileURLToPath(new URL('../../../../../resources/agents', import.meta.url));

const made: string[] = [];

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
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
name: finder
description: Finds things.
tools: [read, grep]
---
You find things.
`;

describe('loadFrom', () => {
  it('reads name, description, tools and prompt', async () => {
    const [found] = await loadFrom([['user', dirWith({ 'finder.md': VALID })]]);
    expect(found).toMatchObject({
      name: 'finder',
      description: 'Finds things.',
      tools: ['read', 'grep'],
      systemPrompt: 'You find things.',
      source: 'user'
    });
  });

  it('defaults an unstated model to inherit and unstated tools to all of them', async () => {
    const [found] = await loadFrom([
      ['user', dirWith({ 'a.md': '---\nname: a\ndescription: d\n---\nprompt' })]
    ]);
    expect(found.model).toBe('inherit');
    expect(found.tools).toBeNull();
  });

  it('lets a later source override a name an earlier one used', async () => {
    const found = await loadFrom([
      ['bundled', dirWith({ 'finder.md': VALID })],
      ['project', dirWith({ 'finder.md': VALID.replace('Finds things.', 'Ours.') })]
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe('Ours.');
    expect(found[0].source).toBe('project');
  });

  it('skips files that are not definitions and folders that do not exist', async () => {
    const dir = dirWith({
      'ok.md': VALID,
      'notes.txt': VALID,
      'no-frontmatter.md': 'just a prompt',
      'bad-name.md': '---\nname: Not Valid\ndescription: d\n---\nprompt',
      'unknown-tool.md': '---\nname: b\ndescription: d\ntools: [launch_missiles]\n---\nprompt',
      'no-prompt.md': '---\nname: c\ndescription: d\n---\n'
    });
    const found = await loadFrom([
      ['user', dir],
      ['project', join(dir, 'nope')]
    ]);
    expect(found.map((d) => d.name)).toEqual(['finder']);
  });

  it('does not end the frontmatter on a --- that is not a whole line', async () => {
    const [found] = await loadFrom([
      ['user', dirWith({ 'a.md': '---\nname: a\ndescription: "a --- b"\n---\nbody\n' })]
    ]);
    expect(found.description).toBe('a --- b');
    expect(found.systemPrompt).toBe('body');
  });

  it('reads the definitions that ship with the app', async () => {
    // The repo's own folder rather than `bundledDir()`: that function answers
    // from where the built bundle sits, which under vitest - running the source
    // tree - is a different place. What is worth asserting here is that the
    // files we ship parse and stay read-only; where the app finds them is a
    // question only the app can answer.
    const found = await loadFrom([['bundled', SHIPPED_DIR]]);
    expect(found.map((d) => d.name)).toEqual(['explore', 'review']);
    // Every shipped one is read-only-ish by intent, and none may write code.
    for (const definition of found) expect(definition.tools).not.toContain('write');
  });
});
