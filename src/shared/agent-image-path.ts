import { OUTPUT_SEPARATOR, type AgentToolCall } from './agent-tools';

/**
 * The file an `image` call wrote.
 *
 * The tool puts the path below the same separator the shell writes its output
 * under, so it is read from there rather than found in the prose: changing the
 * wording of the result cannot then silently stop the picture being found.
 *
 * Shared rather than living beside the transcript that draws it, because the
 * gallery asks the same question of a session it is not showing - which
 * conversation, and which prompt, made this file - and two answers to that
 * would be two galleries.
 */
export function generatedImagePath(call: AgentToolCall): string | null {
  if (call.name !== 'image' || call.error !== null || call.result === null) return null;
  const at = call.result.indexOf(`${OUTPUT_SEPARATOR}\n`);
  const path = (
    at === -1 ? call.result : call.result.slice(at + OUTPUT_SEPARATOR.length + 1)
  ).trim();
  return path === '' ? null : path;
}
