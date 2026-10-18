import { describe, expect, it } from 'vitest';
import { agentRoleText } from '../agent-roles';

describe('agentRoleText', () => {
  it("keeps a Claude Code agent's description and model, and its body as the instructions", () => {
    const text = [
      '---',
      'name: reviewer',
      'description: Reviews the diff.',
      'tools: Read, Grep',
      'model: sonnet',
      'color: blue',
      '---',
      '',
      'Review the diff for bugs.',
      ''
    ].join('\n');
    expect(agentRoleText('.claude/agents/reviewer.md', text)).toBe(
      '---\nname: reviewer\ndescription: Reviews the diff.\nruntime: claude\nmodel: sonnet\n---\n\nReview the diff for bugs.\n'
    );
  });

  it("drops a model the role's runtime would not know", () => {
    const inherit = '---\ndescription: D\nmodel: inherit\n---\nGo.\n';
    expect(agentRoleText('.claude/agents/a.md', inherit)).not.toContain('model:');
    const opencode = '---\ndescription: D\nmodel: anthropic/claude-sonnet-4-5\n---\nGo.\n';
    expect(agentRoleText('.opencode/agents/a.md', opencode)).toBe(
      '---\nname: a\ndescription: D\nruntime: eva\n---\n\nGo.\n'
    );
    const eva = '---\ndescription: D\nmodel: qwen/qwen3-coder\n---\nGo.\n';
    expect(agentRoleText('.eva/agents/a.md', eva)).toContain('model: qwen/qwen3-coder');
  });

  it('fills in what a file without frontmatter leaves out', () => {
    expect(agentRoleText('.claude/agents/plain.md', '# Plain\n\nDo it.\n')).toBe(
      '---\nname: plain\ndescription: Imported from .claude/agents/plain.md.\nruntime: claude\n---\n\n# Plain\n\nDo it.\n'
    );
    expect(agentRoleText('.claude/agents/empty.md', '---\ndescription: Empty.\n---\n')).toContain(
      '\n\nEmpty.\n'
    );
    expect(agentRoleText('src/a.md', 'x')).toBeNull();
  });
});
