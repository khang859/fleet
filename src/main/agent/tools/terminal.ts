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
  // The one thing this tool must not be: the way around a refusal. Typing a
  // command the user just declined into the terminal they are sitting at, one
  // Enter from running, would answer their decision with a smaller version of
  // the same question.
  if (ctx.wasRefused(args.command)) return REFUSED;

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

const REFUSED: AgentToolResult = {
  text: 'The user already turned this command down in this turn, so it was not handed to them a second way. Do not run it and do not offer it again - say what you were trying to do, and leave the decision with them.',
  summary: 'not allowed'
};
