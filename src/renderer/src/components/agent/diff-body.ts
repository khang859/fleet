import { z } from 'zod';
import { DIFF_MAX_LINES, type AgentToolCall } from '../../../../shared/agent-tools';
import { diffLineKind } from '../../../../shared/agent-diff';

/**
 * What to draw as a diff for a tool call, or null when it did not change a file.
 *
 * Everything before the first hunk is the tool talking to the model - the
 * headline, and any reminder attached to the change. It is dropped: the row
 * above already says which file changed and by how much, and an instruction
 * addressed to the model is not something to show the user as though it were
 * addressed to them.
 *
 * A created file has no diff, because sending the model back the file it just
 * wrote would be paying twice for the same lines. The pane does not have that
 * problem - it already holds what was written, in the call's own arguments - so
 * it shows the new file as what it is: every line, added.
 */
export function diffBody(call: AgentToolCall): string[] | null {
  const lines = (call.result ?? '').split('\n');
  const start = lines.findIndex((line) => diffLineKind(line) === 'hunk');
  if (start !== -1) return lines.slice(start);
  // A write with no diff either created the file or found it already correct,
  // and only the first has anything to show. A created file is summarised by
  // its length, which is what tells the two apart.
  const created = call.name === 'write' && /^\d+ lines?$/.test(call.summary ?? '');
  return created ? createdBody(call.args) : null;
}

/** The `content` a write was given, as added lines. */
function createdBody(args: string): string[] | null {
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return null;
  }
  const parsed = z.object({ content: z.string() }).safeParse(json);
  if (!parsed.success) return null;

  const lines = parsed.data.content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return null;

  const shown = lines.slice(0, DIFF_MAX_LINES).map((line) => `+${line}`);
  return lines.length > DIFF_MAX_LINES
    ? [...shown, `… ${lines.length - DIFF_MAX_LINES} more lines`]
    : shown;
}
