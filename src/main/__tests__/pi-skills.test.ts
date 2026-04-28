import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('bundled Pi skills', () => {
  it('has parseable YAML frontmatter for every bundled skill', () => {
    const skillsDir = join(process.cwd(), 'resources', 'pi-skills');
    const skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(skillNames.length).toBeGreaterThan(0);

    for (const skillName of skillNames) {
      const skillPath = join(skillsDir, skillName, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf-8');
      const endIndex = content.indexOf('\n---', 3);

      expect(content.startsWith('---')).toBe(true);
      expect(endIndex).toBeGreaterThan(-1);
      expect(() => parse(content.slice(4, endIndex))).not.toThrow();
    }
  });
});
