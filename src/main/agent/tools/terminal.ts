import type { AgentToolContext, AgentToolResult, TerminalArgs } from '../../../shared/agent-tools';

/**
 * Hand a command to the user.
 *
 * `bash` runs with no terminal and nobody to type into it, which is the right
 * shape for the commands an agent should be running unattended and no shape at
 * all for `gh auth login`. Rather than teach the agent's shell to prompt - a
 * password box in a transcript, with the agent watching - the command goes
 * where those belong: a terminal pane beside the agent, with a real tty and the
 * person who has the password already sitting in front of it.
 *
 * It is typed there and left unrun. The user reads the command before it
 * happens and presses Enter, which is the one confirmation step this agent has
 * anywhere, and the one place it costs nothing: they were about to type it.
 *
 * Nothing comes back. What happens in that terminal is between the command and
 * the user, and the model learns how it went the way a colleague would - by
 * being told, and by checking afterwards.
 */
export function runTerminal(args: TerminalArgs, ctx: AgentToolContext): AgentToolResult {
  ctx.handOff(args.command);

  return {
    text: [
      `${args.command} is now typed into a terminal beside this pane, waiting for the user to press Enter.`,
      'Tell them what it is for and what they will be asked, then stop and let them do it.',
      'Nothing comes back here: when they say it is done, check for yourself with a command that needs no terminal.'
    ].join(' '),
    summary: 'waiting on you'
  };
}
