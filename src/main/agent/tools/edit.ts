import { stat } from 'node:fs/promises';
import { DIFF_MAX_LINES, type AgentToolResult, type EditArgs } from '../../../shared/agent-tools';
import { diffLines, diffStats, formatUnified, toHunks } from '../../../shared/agent-diff';
import { displayPath, resolveInsideCwd } from './paths';
import { applyEdit } from './edit-match';
import { requireFresh } from './freshness';
import { checkEditableSize, readTextFile, writeTextFile } from './text-file';

/**
 * Change part of a file.
 *
 * The result is a diff rather than a confirmation. A model that is told "done"
 * has to take its own edit on trust and will happily build the next three edits
 * on a mistake in this one; a diff is the only answer that says what actually
 * happened, and it is the same text the pane shows the user, so the two cannot
 * disagree about what was written.
 */
export async function runEdit(args: EditArgs, cwd: string): Promise<AgentToolResult> {
  const abs = resolveInsideCwd(args.path, cwd);
  const shown = displayPath(abs, cwd);

  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`${shown} does not exist - use write to create it`);
  if (info.isDirectory()) throw new Error(`${shown} is a folder, not a file`);
  checkEditableSize(info.size, shown);
  requireFresh(abs, info, shown);

  const before = await readTextFile(abs, shown);
  const edited = applyEdit(before.text, args.oldString, args.newString, args.replaceAll ?? false);

  await writeTextFile(abs, edited.text, before.crlf);
  const notes = edited.reindented
    ? [
        'Your text matched only after ignoring indentation - the replacement was re-indented to fit.'
      ]
    : [];
  return diffReport(`Edited ${shown}`, before.text, edited.text, notes);
}

/**
 * A reminder that rides along with every change.
 *
 * The system prompt says this too, and models with weaker instruction following
 * drift from it by the third tool call - so it is repeated here, where it
 * arrives attached to the thing it is about. That only works if it stays rare:
 * a line appended to every result is a line every model learns to skip, which
 * is why the reminders in this file fire on a change and nothing else.
 */
const SEEN_BY_USER =
  'The user is shown this change as a diff, so do not repeat the new code in your reply.';

/**
 * What changed, as a diff with a headline.
 *
 * Everything above the first `@@` is written for the model - the counts, and
 * whatever it needs reminding of. The pane drops it and shows the diff, so a
 * note meant for the model never turns up in the user's transcript as though
 * they were being told what to do.
 */
export function diffReport(
  headline: string,
  before: string,
  after: string,
  notes: string[] = []
): AgentToolResult {
  const ops = diffLines(before, after);
  const { added, removed } = diffStats(ops);

  return {
    text: [
      `${headline} (+${added} -${removed})`,
      ...notes,
      SEEN_BY_USER,
      formatUnified(toHunks(ops), DIFF_MAX_LINES)
    ].join('\n'),
    summary: `+${added} -${removed}`
  };
}
