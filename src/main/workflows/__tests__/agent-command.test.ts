import { describe, expect, it } from 'vitest';
import { agentCommandLine, type AgentCommand } from '../agent-command';

function command(fields: Partial<AgentCommand> = {}): AgentCommand {
  return {
    program: 'pi',
    mode: 'normal',
    briefPath: '/runs/brief.md',
    message: 'Start now.',
    resume: null,
    devExtension: null,
    ...fields
  };
}

describe('agentCommandLine', () => {
  it('quotes a path with a space and a single quote', () => {
    const line = agentCommandLine(command({ briefPath: "/runs/it's here/brief.md" }), 'darwin');

    expect(line).toBe(
      `exec pi '--append-system-prompt' '/runs/it'\\''s here/brief.md' 'Start now.'`
    );
  });

  it('runs pi with the extension and session it is given', () => {
    const line = agentCommandLine(
      command({ devExtension: '/dev/fleet.js', resume: '/t/a.jsonl' }),
      'linux'
    );

    expect(line).toBe(
      `exec pi '-ne' '-e' '/dev/fleet.js' '--session' '/t/a.jsonl' '--append-system-prompt' '/runs/brief.md' 'Start now.'`
    );
  });

  it('approves a team PR for pi', () => {
    expect(agentCommandLine(command({ mode: 'team-pr' }), 'linux')).toContain(`'--approve'`);
  });

  it('locks pi to read tools', () => {
    const line = agentCommandLine(command({ mode: 'locked' }), 'linux');

    expect(line).toContain(`'--no-approve' '--tools' 'read,grep,find,ls,fleet_*'`);
    expect(line).toContain(`'--exclude-tools' 'mcp__*'`);
  });

  it('runs claude with the brief file and a resume id', () => {
    const line = agentCommandLine(command({ program: 'claude', resume: 'abc' }), 'darwin');

    expect(line).toBe(
      `exec claude '--append-system-prompt-file' '/runs/brief.md' '--resume' 'abc' 'Start now.'`
    );
  });

  it('adds nothing for claude in normal and team modes', () => {
    const normal = agentCommandLine(command({ program: 'claude' }), 'linux');
    const team = agentCommandLine(command({ program: 'claude', mode: 'team-pr' }), 'linux');

    expect(team).toBe(normal);
  });

  it('locks claude to read tools', () => {
    const line = agentCommandLine(command({ program: 'claude', mode: 'locked' }), 'linux');

    expect(line).toContain(`'--tools' 'Read,Grep,Glob'`);
    expect(line).toContain(`'--strict-mcp-config'`);
  });

  it('never passes the dev extension when a program has none', () => {
    const line = agentCommandLine(command({ program: 'claude', devExtension: '/x' }), 'linux');

    expect(line).not.toContain('/x');
  });

  it('uses PowerShell quotes and exit on Windows', () => {
    const line = agentCommandLine(command({ briefPath: "C:\\it's\\brief.md" }), 'win32');

    expect(line).toBe(`pi '--append-system-prompt' 'C:\\it''s\\brief.md' 'Start now.'; exit`);
  });

  describe('stage files', () => {
    it('lets a Pi reader use only read tools and Fleet tools', () => {
      const line = agentCommandLine(command({ mode: 'locked' }), 'linux');

      expect(line).toContain(`'--no-approve' '--tools' 'read,grep,find,ls,fleet_*'`);
      expect(line).toContain(`'--exclude-tools' 'mcp__*'`);
    });

    it('stops Pi from its trust question for a writer', () => {
      expect(agentCommandLine(command({ mode: 'write' }), 'linux')).toContain(`'--no-approve'`);
    });

    it('brings back the write tools when Pi resumes', () => {
      const line = agentCommandLine(command({ mode: 'write', resume: '/t/a.jsonl' }), 'linux');

      expect(line).toContain(`'--tools' '+edit,+write,+bash'`);
      expect(line).toContain(`'--session' '/t/a.jsonl'`);
    });

    it('starts a Claude Code plan agent in plan mode', () => {
      const cmd = command({ program: 'claude', mode: 'write', permissionMode: 'plan' });

      expect(agentCommandLine(cmd, 'linux')).toContain(`'--permission-mode' 'plan'`);
    });

    it('never lets add-dir take the message', () => {
      const cmd = command({ program: 'claude', mode: 'locked', addDir: '/runs/one' });
      const line = agentCommandLine(cmd, 'linux');

      expect(line.indexOf(`'--add-dir' '/runs/one'`)).toBeLessThan(line.indexOf('--append'));
      expect(line.endsWith(`'Start now.'`)).toBe(true);
      expect(line).not.toMatch(/'--add-dir' '[^']+' 'Start now\.'/);
    });

    it('gives a talking Claude Code reader the question tool', () => {
      const cmd = command({ program: 'claude', mode: 'locked', talks: true });

      expect(agentCommandLine(cmd, 'linux')).toContain('AskUserQuestion');
    });

    it('gives a silent Claude Code reader no question tool', () => {
      const cmd = command({ program: 'claude', mode: 'locked' });

      expect(agentCommandLine(cmd, 'linux')).not.toContain('AskUserQuestion');
    });
  });
});
