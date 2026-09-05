import { parseCommandLine, renderCommandPrompt } from '../../../shared/agent-commands';
import { FUSION_COMMAND_NAME } from '../../../shared/agent-fusion';
import { loadCommands } from './definitions';

/**
 * A `/command` line, as the model should read it.
 *
 * Done here, on the way to the wire, rather than in the composer, and that is
 * the whole design. The transcript keeps what the user typed - one line, which
 * is what they meant and what Up recalls - while the model is handed the prompt
 * behind it. Nothing has to be stored twice for that to work.
 *
 * It also survives the conversation carrying on. Main is stateless: the pane
 * resends its whole history every turn and every user message in it comes back
 * through here, so a `/pr-review` sent ten rounds ago still arrives with its
 * instructions attached instead of decaying into a bare slash and a number.
 * A file edited in between takes effect from the next turn, the same way an
 * `@`-mentioned file is re-read rather than remembered.
 *
 * Anything that is not a command Fleet can find is left exactly as it is. A
 * message that merely opens with a slash is a message.
 */
export async function expandCommand(text: string, cwd: string): Promise<string> {
  const line = parseCommandLine(text);
  if (line === null) return text;

  const definition = (await loadCommands(cwd)).find((c) => c.name === line.name);
  if (definition === undefined) return text;

  return renderCommandPrompt(definition.template, line.args);
}

/**
 * Whether this turn is the one the user asked for a panel review on.
 *
 * The arming check for `openrouter:fusion`, and it is a text match rather than
 * a flag on the request for one reason: main is stateless and the pane resends
 * its whole history every turn, so the only thing that reliably says "this turn
 * is the review" is the message that started it. A flag would have to be minted
 * in the composer, carried through the send, and then not carried on the rounds
 * that follow - three places to get wrong for something the text already says.
 *
 * It matches the command name and not the prompt behind it. A user or project
 * file that shadows `fusion.md` still arms the tool, which is the right answer:
 * they have replaced the brief, not the intent, and a `/fusion` that quietly
 * ran without a panel would be the confusing one.
 */
export function isFusionTurn(text: string): boolean {
  return parseCommandLine(text)?.name === FUSION_COMMAND_NAME;
}
