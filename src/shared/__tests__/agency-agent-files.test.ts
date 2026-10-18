import { describe, expect, it } from 'vitest';
import { agentFile, roleNameOf, skillFolder, skillsIn } from '../agency-agent-files';

describe('agentFile', () => {
  it('names the role an agent file makes and the runtime it runs on', () => {
    expect(agentFile('.claude/agents/reviewer.md')).toEqual({
      folder: '.',
      role: 'reviewer',
      runtime: 'claude'
    });
    expect(agentFile('fola-journey/.opencode/agents/journey-domain-reviewer.md')).toEqual({
      folder: 'fola-journey',
      role: 'journey-domain-reviewer',
      runtime: 'eva'
    });
    expect(agentFile('.agents/agents/Lint_Fixer.md')?.role).toBe('lint-fixer');
    expect(agentFile('.eva/agents/x.md')?.runtime).toBe('eva');
  });

  it('is null for other files, nested agent folders and paths that climb out', () => {
    expect(agentFile('.claude/agents/notes/x.md')).toBeNull();
    expect(agentFile('.claude/agents/x.txt')).toBeNull();
    expect(agentFile('../.claude/agents/x.md')).toBeNull();
    expect(agentFile('.claude/agents/---.md')).toBeNull();
  });
});

describe('roleNameOf', () => {
  it('makes a crew role name of at most 40 characters', () => {
    expect(roleNameOf('Code Reviewer!')).toBe('code-reviewer');
    expect(roleNameOf(`${'a'.repeat(39)}-b`)).toBe('a'.repeat(39));
    expect(roleNameOf('__')).toBeNull();
  });
});

describe('skillFolder and skillsIn', () => {
  it('reads the runtime from the skill folder', () => {
    expect(skillFolder('.claude/skills/sweep')).toEqual({
      folder: '.',
      name: 'sweep',
      runtime: 'claude'
    });
    expect(skillFolder('libs/core/.agents/skills/lint')?.runtime).toBe('eva');
    expect(skillFolder('.opencode/skills/x')).toBeNull();
  });

  it("lists a repository root's skills by runtime, once each, and no nested ones", () => {
    expect(
      skillsIn([
        '.claude/skills/sweep/SKILL.md',
        '.claude/skills/sweep/notes.md',
        '.eva/skills/lint/SKILL.md',
        '.agents/skills/lint/SKILL.md',
        '.agents/skills/deploy/SKILL.md',
        'src/.claude/skills/deep/SKILL.md'
      ])
    ).toEqual({ claude: ['sweep'], eva: ['deploy', 'lint'] });
  });
});
