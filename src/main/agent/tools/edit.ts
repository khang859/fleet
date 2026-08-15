import { stat } from 'node:fs/promises';
import {
  DIFF_MAX_LINES,
  type AgentToolContext,
  type AgentToolResult,
  type EditArgs
} from '../../../shared/agent-tools';
import { diffLines, diffStats, formatUnified, toHunks } from '../../../shared/agent-diff';
import { displayPath, resolveInsideCwd } from './paths';
import { applyEdit } from './edit-match';
import { requireFresh } from './freshness';
import { checkEditableSize, readTextFile, writeTextFile } from './text-file';

/**
 * Change part of a file, in one place or in twenty.
 *
 * The result is a diff rather than a confirmation. A model that is told "done"
 * has to take its own edit on trust and will happily build the next three edits
 * on a mistake in this one; a diff is the only answer that says what actually
 * happened, and it is the same text the pane shows the user, so the two cannot
 * disagree about what was written.
 *
 * Several replacements arrive together because a change to a file is rarely one
 * place in it, and the alternative - one call each - is a round trip per place
 * with the file readable and wrong in between. They are applied in order to the
 * text in memory, so a later one may match what an earlier one wrote, and
 * nothing reaches disk until every one of them has matched. Half a rename is
 * worse than no rename: it compiles less often, but it reads as finished.
 */
export async function runEdit(args: EditArgs, ctx: AgentToolContext): Promise<AgentToolResult> {
  const abs = resolveInsideCwd(args.path, ctx.cwd);
  const shown = displayPath(abs, ctx.cwd);

  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`${shown} does not exist - use write to create it`);
  if (info.isDirectory()) throw new Error(`${shown} is a folder, not a file`);
  checkEditableSize(info.size, shown);
  requireFresh(ctx.threadId, abs, info, shown);

  const before = await readTextFile(abs, shown);
  const edited = applyAll(before.text, args.edits);

  await writeTextFile(ctx.threadId, abs, edited.text, before.crlf);
  const notes = edited.reindented
    ? [
        'Your text matched only after ignoring indentation - the replacement was re-indented to fit.'
      ]
    : [];
  return diffReport(`Edited ${shown}`, before.text, edited.text, notes);
}

/**
 * Every replacement, or none of them.
 *
 * `applyEdit` throws a sentence written for the model to act on, and that
 * sentence is about text rather than about position - so on a call carrying
 * several, it would leave the model unable to tell which of its entries the
 * complaint is about. The number is prefixed for exactly that, and only when
 * there is more than one: on the common single-hunk call, "Change 1 of 1" is
 * noise in front of the part that matters.
 */
function applyAll(
  original: string,
  edits: EditArgs['edits']
): { text: string; reindented: boolean } {
  let text = original;
  let reindented = false;

  for (const [i, hunk] of edits.entries()) {
    try {
      const outcome = applyEdit(text, hunk.oldString, hunk.newString, hunk.replaceAll ?? false);
      text = outcome.text;
      reindented ||= outcome.reindented;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (edits.length === 1) throw new Error(why);
      throw new Error(
        `Change ${i + 1} of ${edits.length} did not apply, so nothing was written and the file is as it was: ${why}`
      );
    }
  }

  return { text, reindented };
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
