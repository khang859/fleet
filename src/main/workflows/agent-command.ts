import type { WorkflowProgram } from '../../shared/workflows';
import { posixShellQuote } from '../remote-ssh/ssh-quote';

/**
 * How much an agent may do. See the Limits part of the design doc.
 * `write` is an agent in a stage file. It has no person at its start, so Pi must
 * not stop at its trust question, which Fleet cannot see.
 */
export type AgentMode = 'normal' | 'team-pr' | 'locked' | 'write';

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
  /** A folder Claude Code reads with no permission stop. */
  addDir?: string;
  /** The agent talks with a person, so read-only Claude Code keeps its question tool. */
  talks?: boolean;
  /** The Claude Code mode to start in. */
  permissionMode?: 'plan' | 'auto' | 'acceptEdits' | 'default';
};

/** A resumed Pi takes back its old tool list, unless the write tools are named. */
const PI_WRITE_TOOLS = '+edit,+write,+bash';

function piAccessArgs(cmd: AgentCommand): string[] {
  if (cmd.mode === 'team-pr') return ['--approve'];
  if (cmd.mode === 'locked') {
    return ['--no-approve', '--tools', 'read,grep,find,ls,fleet_*', '--exclude-tools', 'mcp__*'];
  }
  if (cmd.mode !== 'write') return [];
  return cmd.resume ? ['--no-approve', '--tools', PI_WRITE_TOOLS] : ['--no-approve'];
}

function piArgs(cmd: AgentCommand): string[] {
  const args = cmd.devExtension ? ['-ne', '-e', cmd.devExtension] : [];
  if (cmd.resume) args.push('--session', cmd.resume);
  args.push('--append-system-prompt', cmd.briefPath);
  return [...args, ...piAccessArgs(cmd)];
}

function claudeReadTools(cmd: AgentCommand): string {
  return cmd.talks ? 'Read,Grep,Glob,AskUserQuestion' : 'Read,Grep,Glob';
}

function claudeArgs(cmd: AgentCommand): string[] {
  // `--add-dir` takes many values, so a later flag must stop it before the message.
  const args = cmd.addDir ? ['--add-dir', cmd.addDir] : [];
  args.push('--append-system-prompt-file', cmd.briefPath);
  if (cmd.resume) args.push('--resume', cmd.resume);
  if (cmd.permissionMode) args.push('--permission-mode', cmd.permissionMode);
  if (cmd.mode === 'locked') {
    args.push('--tools', claudeReadTools(cmd), '--setting-sources', 'user', '--strict-mcp-config');
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
