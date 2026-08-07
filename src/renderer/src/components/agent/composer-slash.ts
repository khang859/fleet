import { Eraser, type LucideIcon } from 'lucide-react';

/**
 * The composer's `/` menu.
 *
 * One command today, and no `kind` to tell commands apart: they would all be
 * the same kind, so the distinction can be added when there is one to make.
 */

/**
 * Every command the menu can run.
 *
 * A union rather than a string, so the composer's dispatch is exhaustive over
 * it: a command added to the table below and nowhere else would be a row the
 * menu offers and nothing answers, and that is a type error rather than a
 * pick that quietly does nothing.
 */
export type AgentSlashCommandName = 'clear';

export type AgentSlashCommand = {
  name: AgentSlashCommandName;
  description: string;
  Icon: LucideIcon;
};

export const AGENT_SLASH_COMMANDS: AgentSlashCommand[] = [
  { name: 'clear', description: 'Start a new session', Icon: Eraser }
];

export type AgentSlashMenu = {
  open: boolean;
  matches: AgentSlashCommand[];
};

/** The whole input is one slash token, and nothing else. */
const SLASH_RE = /^\/([A-Za-z0-9_.-]*)$/;

/**
 * Whether the menu is up, and what is in it.
 *
 * Closed when nothing matches, rather than open and empty: with a fixed set of
 * built-in commands "none of these" is not news the user needs a popover to
 * hear, and an empty box over the composer is just something in the way.
 */
export function agentSlashMenu(text: string, dismissed: boolean): AgentSlashMenu {
  const match = SLASH_RE.exec(text);
  if (!match || dismissed) return { open: false, matches: [] };
  const query = match[1].toLowerCase();
  const matches = AGENT_SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  return { open: matches.length > 0, matches };
}

/**
 * The command a submitted line *is*, if it is one.
 *
 * Typing `/clear` in full and pressing Enter has to do what picking it from
 * the menu does, and this is what keeps those from being two separate lists.
 */
export function agentSlashCommand(text: string): AgentSlashCommand | undefined {
  const typed = text.trim().toLowerCase();
  return AGENT_SLASH_COMMANDS.find((c) => `/${c.name}` === typed);
}
