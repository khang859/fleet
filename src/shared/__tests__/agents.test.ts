import { describe, expect, it } from 'vitest';
import { agentOptions, isFirstAgentPick, readAgentChoice, worktreeStartText } from '../agents';

describe('readAgentChoice', () => {
  it('keeps every choice Fleet knows', () => {
    for (const choice of ['none', 'claude', 'pi', 'custom']) {
      expect(readAgentChoice(choice)).toBe(choice);
    }
  });

  it('reads anything else as no choice yet', () => {
    for (const saved of ['eva', '', undefined, null, 3]) {
      expect(readAgentChoice(saved)).toBeNull();
    }
  });
});

describe('isFirstAgentPick', () => {
  it('is true for an agent when no default is set', () => {
    expect(isFirstAgentPick(null, 'pi')).toBe(true);
    expect(isFirstAgentPick(null, 'custom')).toBe(true);
  });

  it('is false for none, which picks no agent', () => {
    expect(isFirstAgentPick(null, 'none')).toBe(false);
  });

  it('is false once a default is set, even a default of none', () => {
    expect(isFirstAgentPick('claude', 'pi')).toBe(false);
    expect(isFirstAgentPick('none', 'pi')).toBe(false);
  });
});

describe('agentOptions', () => {
  it('lists none and the known agents, with no custom row when no command is set', () => {
    const options = agentOptions('   ');

    expect(options.map((o) => o.choice)).toEqual(['none', 'claude', 'pi']);
    expect(options.map((o) => o.label)).toEqual(['None', 'Claude Code', 'Pi']);
    expect(options.map((o) => o.command)).toEqual(['', 'claude', 'pi']);
  });

  it('adds the trimmed custom command, named after itself', () => {
    expect(agentOptions('  codex --yolo ').at(-1)).toEqual({
      choice: 'custom',
      label: 'codex --yolo',
      command: 'codex --yolo'
    });
  });
});

describe('worktreeStartText', () => {
  it('puts the agent on its own line after the setup', () => {
    expect(worktreeStartText('npm install\nnpm run build', 'claude')).toBe(
      'npm install\nnpm run build\nclaude'
    );
  });

  it('types whichever one there is', () => {
    expect(worktreeStartText('npm install', '')).toBe('npm install');
    expect(worktreeStartText('', 'pi')).toBe('pi');
  });

  it('types nothing when there is neither', () => {
    expect(worktreeStartText('', '')).toBeUndefined();
  });
});
