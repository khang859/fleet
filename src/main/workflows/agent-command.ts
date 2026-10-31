import type { WorkflowProgram } from '../../shared/workflows';
import { posixShellQuote } from '../remote-ssh/ssh-quote';

/** How much an agent may do. See the Limits part of the design doc. */
export type AgentMode = 'normal' | 'team-pr' | 'locked' | 'post';

export type AgentCommand = {
  program: WorkflowProgram;
  mode: AgentMode;
  /** The Fleet-made file with the whole brief. */
  briefPath: string;
  /** Fixed words from Fleet, never TOML or input text. Null waits for a person. */
  message: string | null;
  /** A transcript to go on from: a file for Pi, a session id for Claude Code. */
  resume: string | null;
  /** A dev app does not install the Pi extension, so it names its own. */
  devExtension: string | null;
};

function piArgs(cmd: AgentCommand): string[] {
  const args = cmd.devExtension ? ['-ne', '-e', cmd.devExtension] : [];
  if (cmd.resume) args.push('--session', cmd.resume);
  args.push('--append-system-prompt', cmd.briefPath);
  if (cmd.mode === 'team-pr') args.push('--approve');
  if (cmd.mode === 'locked') {
    args.push('--no-approve', '--tools', 'read,grep,find,ls,fleet_*', '--exclude-tools', 'mcp__*');
  }
  if (cmd.mode === 'post') {
    args.push('--no-approve', '--tools', 'fleet_post_item', '--exclude-tools', 'mcp__*');
  }
  return args;
}

function claudeArgs(cmd: AgentCommand): string[] {
  const args = ['--append-system-prompt-file', cmd.briefPath];
  if (cmd.resume) args.push('--resume', cmd.resume);
  if (cmd.mode === 'locked') {
    args.push('--tools', 'Read,Grep,Glob', '--setting-sources', 'user', '--strict-mcp-config');
  }
  // `--tools ""` refuses a mod's tool, so one tool stays and the mod blocks it.
  if (cmd.mode === 'post') {
    args.push('--tools', 'Read', '--setting-sources', 'user', '--strict-mcp-config');
  }
  return args;
}

function quotePowerShell(arg: string): string {
  return `'${arg.replaceAll("'", "''")}'`;
}

/**
 * The line typed into a new shell. `exec` makes the pane end with the agent, so
 * Fleet sees the exit. PowerShell has no `exec`, so it exits after the program.
 */
export function agentCommandLine(
  cmd: AgentCommand,
  platform: NodeJS.Platform = process.platform
): string {
  const args = cmd.program === 'pi' ? piArgs(cmd) : claudeArgs(cmd);
  const words = cmd.message === null ? args : [...args, cmd.message];
  if (platform === 'win32') {
    return `${cmd.program} ${words.map(quotePowerShell).join(' ')}; exit`;
  }
  return `exec ${cmd.program} ${words.map(posixShellQuote).join(' ')}`;
}
