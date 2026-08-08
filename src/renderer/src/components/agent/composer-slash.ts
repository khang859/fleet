import { Eraser, FileText, type LucideIcon } from 'lucide-react';
import { parseCommandLine, type AgentCommandDescriptor } from '../../../../shared/agent-commands';

/**
 * The composer's `/` menu.
 *
 * Two kinds of row, and the difference is real rather than bookkeeping. A
 * builtin *is* behaviour - `/clear` starts a new session and never reaches the
 * model - so there is a case for it in the composer and the set of them is
 * closed. A prompt command is a file, and every one of them does the same thing
 * here: it goes to the model, which reads the prompt behind it. That is why one
 * of these is a string union with a switch over it and the other is a name off
 * disk with no switch anywhere - there is nothing per-command to be exhaustive
 * about once a command is only a prompt.
 *
 * So adding a command is adding a file. Adding a *builtin* is adding code, and
 * the union below is what makes forgetting the second half a lint error rather
 * than a row that quietly does nothing.
 */

/** Every builtin. The composer answers each of these itself. */
export type AgentSlashCommandName = 'clear';

export type AgentSlashCommand =
  | { kind: 'builtin'; name: AgentSlashCommandName; description: string; Icon: LucideIcon }
  | { kind: 'prompt'; name: string; description: string; Icon: LucideIcon };

export const BUILTIN_SLASH_COMMANDS: AgentSlashCommand[] = [
  { kind: 'builtin', name: 'clear', description: 'Start a new session', Icon: Eraser }
];

/**
 * One row for a command found on disk.
 *
 * All of them share an icon, and it is a page: what the row stands for is a
 * file someone wrote, which is the whole mental model of the feature. A glyph
 * per command would mean a table in here naming files, which is the coupling
 * the arrangement exists to avoid.
 */
export function promptCommand(descriptor: AgentCommandDescriptor): AgentSlashCommand {
  return { kind: 'prompt', ...descriptor, Icon: FileText };
}

export type AgentSlashMenu = {
  open: boolean;
  matches: AgentSlashCommand[];
};

/** The whole input is one slash token, and nothing else. */
const SLASH_RE = /^\/([A-Za-z0-9_.-]*)$/;

/**
 * Whether the user is naming a command right now.
 *
 * Separate from `agentSlashMenu` because it answers without the roster: it is
 * what tells the roster to go and refresh itself, and a question that needed
 * the answer first could not ask it.
 */
export function isSlashQuery(text: string): boolean {
  return SLASH_RE.test(text);
}

/**
 * Whether the menu is up, and what is in it.
 *
 * Still only while the input is a bare slash token: once a space is typed the
 * user has moved on to arguments, and there is nothing left to narrow. Closed
 * when nothing matches, rather than open and empty - "none of these" is not
 * news the user needs a popover to hear, and an empty box over the composer is
 * just something in the way.
 */
export function agentSlashMenu(
  text: string,
  commands: AgentSlashCommand[],
  dismissed: boolean
): AgentSlashMenu {
  const match = SLASH_RE.exec(text);
  if (!match || dismissed) return { open: false, matches: [] };
  const query = match[1].toLowerCase();
  const matches = commands.filter((c) => c.name.startsWith(query));
  return { open: matches.length > 0, matches };
}

/**
 * The command a submitted line *is*, and what was typed after it.
 *
 * Typing a command in full and pressing Enter has to do what picking it from
 * the menu does, and this is what keeps those from being two separate lists.
 *
 * A builtin takes nothing after its name: `/clear the cache please` is a
 * sentence about clearing, not an instruction to clear, and sending it as a
 * message is the only reading that cannot lose someone's words. A prompt
 * command takes everything after the name and hands it on unexamined - which
 * part of it is a number and which is a note is for the prompt to decide.
 */
export function agentSlashCommand(
  text: string,
  commands: AgentSlashCommand[]
): { command: AgentSlashCommand; args: string } | undefined {
  const line = parseCommandLine(text);
  if (line === null) return undefined;
  const command = commands.find((c) => c.name === line.name);
  if (command === undefined) return undefined;
  if (command.kind === 'builtin' && line.args !== '') return undefined;
  return { command, args: line.args };
}
