import { OUTPUT_SEPARATOR, type AgentToolCall } from '../../../../shared/agent-tools';
import { toFleetImageUrl } from '../../../../shared/path-platform';

/**
 * What the row shows for a call that is not a change to a file: the command's
 * own output, without the part of the result that was written for the model.
 *
 * A tool result is two things at once. `Exit status 1 after 0.4s` and any
 * reminder about reaching for the shell too early are the tool talking to the
 * model; the output below the separator is the thing the user asked to see. The
 * row already says how the command ended, so only the second half is drawn -
 * an instruction addressed to the model has no place in the user's transcript.
 *
 * Anything without a separator - every other tool, and every failure - is shown
 * whole, because then the result is all there is.
 */
export function outputBody(result: string): string {
  const at = result.indexOf(`${OUTPUT_SEPARATOR}\n`);
  return at === -1 ? result : result.slice(at + OUTPUT_SEPARATOR.length + 1);
}

/** The text a finished call shows behind its disclosure, or null for nothing. */
export function toolBody(call: AgentToolCall): string | null {
  if (call.error !== null) return call.error;
  if (call.result === null) return null;
  const body = outputBody(call.result);
  return body === '' ? null : body;
}

/**
 * The picture a finished call has to show: where it is on disk, and the same
 * thing as something an `<img>` can load.
 *
 * Both, because the file is as much of the result as the pixels are. The row
 * draws the picture from `src`, and `path` is what the user needs when they
 * want to do anything else with it - and for a generated image that path
 * exists nowhere else on screen.
 *
 * Two calls produce one, and they say so differently because they mean
 * different things. `image` made a file, and writes its path below the
 * separator the way the shell writes its output there - read that way rather
 * than by finding a path in the prose, so changing the wording of the result
 * cannot silently stop the picture showing. `read` did not make anything; it
 * looked at a file that was already there, and says which one on the call.
 */
export function imageBody(call: AgentToolCall): { path: string; src: string } | null {
  if (call.error !== null) return null;
  if (call.image !== null) return located(call.image.path);
  if (call.name !== 'image' || call.result === null) return null;
  const path = outputBody(call.result).trim();
  return path === '' ? null : located(path);
}

function located(path: string): { path: string; src: string } {
  return { path, src: toFleetImageUrl(path) };
}
