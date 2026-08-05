import { OUTPUT_SEPARATOR, type AgentToolCall } from '../../../../shared/agent-tools';

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
