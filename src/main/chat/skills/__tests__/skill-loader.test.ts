import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillMd, scanSkillsDir, estimateTokens } from '../skill-loader';

describe('parseSkillMd', () => {
  it('splits frontmatter from body', () => {
    const md = `---\nname: demo\ndescription: A demo skill\n---\n\n# Body\nDo the thing.`;
    const parsed = parseSkillMd(md);
    expect(parsed).toMatchObject({ name: 'demo', description: 'A demo skill' });
    expect(parsed?.body).toBe('# Body\nDo the thing.');
  });

  it('parses folded `>-` descriptions and allowed-tools', () => {
    const md = `---\nname: rev\ndescription: >-\n  Long folded\n  description here.\nallowed-tools:\n  - bash\n  - read_file\n---\nbody`;
    const parsed = parseSkillMd(md);
    expect(parsed?.description).toBe('Long folded description here.');
    expect(parsed?.allowedTools).toEqual(['bash', 'read_file']);
  });

  it('returns null without frontmatter or required fields', () => {
    expect(parseSkillMd('no frontmatter here')).toBeNull();
    expect(parseSkillMd('---\nname: x\n---\nbody')).toBeNull(); // missing description
    expect(parseSkillMd('---\ndescription: y\n---\nbody')).toBeNull(); // missing name
  });

  it('returns null on malformed YAML', () => {
    expect(parseSkillMd('---\nname: : :\n  bad\n---\nbody')).toBeNull();
  });
});

describe('scanSkillsDir', () => {
  const root = join(tmpdir(), `fleet-skill-loader-${process.pid}`);
  beforeAll(() => {
    mkdirSync(join(root, 'good'), { recursive: true });
    writeFileSync(
      join(root, 'good', 'SKILL.md'),
      `---\nname: good\ndescription: A good skill\n---\nrun stuff`
    );
    writeFileSync(join(root, 'good', 'run.sh'), '#!/bin/sh\necho hi');
    // a folder without SKILL.md is ignored
    mkdirSync(join(root, 'empty'), { recursive: true });
    // a malformed skill is skipped, not thrown
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'SKILL.md'), 'no frontmatter');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads valid skills and lists their extra files', () => {
    const skills = scanSkillsDir(root, 'personal');
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'good', scope: 'personal', body: 'run stuff' });
    expect(skills[0].files).toEqual(['run.sh']);
  });

  it('returns [] for a missing root', () => {
    expect(scanSkillsDir(join(root, 'does-not-exist'), 'bundled')).toEqual([]);
  });
});

describe('estimateTokens', () => {
  it('approximates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
