import { z } from 'zod';

/**
 * Commands: a prompt the user runs by name instead of typing out.
 *
 * The same argument a subagent definition makes. A command is a prompt, and a
 * prompt is something you edit, diff, and review - so it lives in a file rather
 * than in a settings box or in this source tree. Three places, most specific
 * winning: the ones that ship with the app, the user's own, and the project's,
 * so "the review this team runs" arrives with a clone.
 *
 * What a command is *not* is a second way to write code. Nothing here decides
 * what `/pr-review` does; the file says what to do and the model does it, with
 * the tools and the permission gate it already had. That is the whole reason
 * adding a command is a file rather than a pull request.
 */

/** Where a definition was found. Decides precedence, and is shown in the UI. */
export type AgentCommandSource = 'project' | 'user' | 'bundled';

/** A command definition, as one `.md` file describes it. */
export type AgentCommandDefinition = {
  name: string;
  /** One line under the name in the `/` menu. Addressed to the user, not the model. */
  description: string;
  /** The body below the frontmatter: what the model is actually told. */
  template: string;
  source: AgentCommandSource;
  path: string;
};

/**
 * What the renderer is told about a command, which is only enough to offer it.
 *
 * The template stays in main. The menu needs a name and a line of description;
 * shipping the body across as well would be a copy of the prompt in a second
 * process, kept fresh by nobody, for a list that never displays it.
 */
export type AgentCommandDescriptor = Pick<AgentCommandDefinition, 'name' | 'description'>;

/**
 * Frontmatter as a file writes it.
 *
 * `name` is constrained for the reason a subagent's is: it is what the user
 * types. A name with a space in it could never be typed as one token after a
 * slash, so the file would sit there offering something the composer cannot
 * match.
 */
export const AgentCommandFrontmatter = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  description: z.string().min(1)
});

/**
 * Names a file may not take.
 *
 * `/clear` is not a prompt - it starts a new session, in the renderer, without
 * ever reaching the model. A file called `clear.md` that shadowed it would stop
 * the one command people rely on from doing anything, so it is dropped rather
 * than honoured. Overriding is for prompts, which all behave the same way;
 * a builtin is behaviour, and there is nothing to override it with.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = ['clear'];

/**
 * The `/name rest` a line is, if it is one.
 *
 * Shared because both sides read it and they must agree. The composer decides
 * whether Enter sends a command or a message, and main decides whether to
 * expand what arrives - two answers to one question, and a line that is a
 * command to one of them and prose to the other would either expand something
 * nobody asked for or send a bare `/pr-review 123` to the model.
 *
 * Everything after the name is one string. Which part of it is a PR number and
 * which is a note is the prompt's problem, not this function's: a regex that
 * tried would be a worse copy of what the model does with the whole line in
 * front of it.
 */
const COMMAND_LINE_RE = /^\/([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/;

export function parseCommandLine(text: string): { name: string; args: string } | null {
  const match = COMMAND_LINE_RE.exec(text.trim());
  if (match === null) return null;
  // `.at` rather than `[2]`, because the arguments group is optional and a
  // bare `/pr-review` leaves it out: TypeScript types both the same way and
  // only one of them admits the `undefined` that is actually there.
  return { name: match[1].toLowerCase(), args: (match.at(2) ?? '').trim() };
}

/**
 * The template with the user's arguments in it.
 *
 * `$ARGUMENTS` is honoured where a file uses it, because a prompt often wants
 * them somewhere other than the end - "review $ARGUMENTS against the checklist
 * below" reads as one instruction where a trailing block does not.
 *
 * A file that mentions it nowhere still gets them, appended and labelled. The
 * alternative is dropping what the user typed on the floor because the prompt
 * they are running forgot a placeholder, and a command that silently ignores
 * its argument is worse than one that puts it somewhere imperfect.
 */
export function renderCommandPrompt(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(args);
  if (args === '') return template;
  return `${template}\n\nWhat the user typed after the command: ${args}`;
}
