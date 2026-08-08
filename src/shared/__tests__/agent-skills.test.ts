import { describe, expect, it } from 'vitest';
import {
  SkillFrontmatter,
  buildSkillSpec,
  renderSkill,
  type SkillDefinition
} from '../agent-skills';
import { toCloneUrl } from '../agent-skill-install';

const skill = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  name: 'ship-it',
  description: 'Ships it. Use when shipping.',
  body: 'Ship the thing, carefully.',
  dir: '/skills/ship-it',
  source: 'user',
  path: '/skills/ship-it/SKILL.md',
  ...over
});

describe('SkillFrontmatter', () => {
  it('reads the six fields the format defines', () => {
    const parsed = SkillFrontmatter.parse({
      name: 'ship-it',
      description: 'Ships it.',
      license: 'MIT',
      compatibility: 'any',
      metadata: { author: 'someone' },
      'allowed-tools': 'bash, read'
    });
    expect(parsed.license).toBe('MIT');
    expect(parsed.metadata).toEqual({ author: 'someone' });
  });

  // The whole point of adopting the standard is that a folder written for
  // another agent loads here unchanged.
  it('ignores fields another agent added rather than refusing the skill', () => {
    const parsed = SkillFrontmatter.safeParse({
      name: 'ship-it',
      description: 'Ships it.',
      context: 'fork',
      'argument-hint': '<pr>'
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a name that is not the slug the format requires', () => {
    for (const name of ['Ship It', 'ship_it', 'ship-', '-ship']) {
      expect(SkillFrontmatter.safeParse({ name, description: 'x' }).success).toBe(false);
    }
  });

  it('refuses a skill with no description, which is all the model gets', () => {
    expect(SkillFrontmatter.safeParse({ name: 'ship-it' }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ name: 'ship-it', description: '' }).success).toBe(false);
  });
});

describe('buildSkillSpec', () => {
  // No skills means no tool, rather than a tool that answers "there are none":
  // the roster is the description, and an empty one is a paragraph of context
  // spent every round on something that can never be called.
  it('is absent when there is nothing to load', () => {
    expect(buildSkillSpec([])).toBeNull();
  });

  it('lists every skill with its description, and takes only those names', () => {
    const spec = buildSkillSpec([skill(), skill({ name: 'review', description: 'Reviews.' })]);
    expect(spec?.function.description).toContain('`ship-it`: Ships it. Use when shipping.');
    expect(spec?.function.parameters.properties).toMatchObject({
      name: { enum: ['ship-it', 'review'] }
    });
    expect(spec?.function.parameters.required).toEqual(['name']);
  });
});

describe('renderSkill', () => {
  it('frames the body as instructions that do not outrank the user', () => {
    const text = renderSkill(skill(), []);
    expect(text).toContain('do not override the user');
    expect(text).toContain('Ship the thing, carefully.');
  });

  // A body written for another agent says "see references/api.md" as though
  // `read` could open it. Naming the files next to the tool that can is what
  // stops the agent concluding the file does not exist.
  it('names the bundled files and how to open them', () => {
    const text = renderSkill(skill(), ['references/API.md']);
    expect(text).toContain('- references/API.md');
    expect(text).toContain('`read` cannot reach them');
  });

  it('says nothing about files when there are none', () => {
    expect(renderSkill(skill(), [])).not.toContain('bundled');
  });
});

describe('toCloneUrl', () => {
  it('takes the three forms a README might have used', () => {
    expect(toCloneUrl('anthropics/skills')).toBe('https://github.com/anthropics/skills.git');
    expect(toCloneUrl('https://github.com/anthropics/skills')).toBe(
      'https://github.com/anthropics/skills'
    );
    expect(toCloneUrl('git@github.com:anthropics/skills.git')).toBe(
      'git@github.com:anthropics/skills.git'
    );
  });

  // The string becomes an argument to `git clone`, which would read a leading
  // dash as a flag rather than as a repository.
  it('refuses anything that would arrive as a flag', () => {
    expect(toCloneUrl('--upload-pack=touch /tmp/pwned')).toBeNull();
    expect(toCloneUrl('-c protocol.ext.allow=always')).toBeNull();
  });

  it('refuses a protocol nobody meant to type', () => {
    expect(toCloneUrl('file:///etc')).toBeNull();
    expect(toCloneUrl('http://example.com/repo')).toBeNull();
    expect(toCloneUrl('ext::sh -c whoami')).toBeNull();
    expect(toCloneUrl('')).toBeNull();
  });
});
