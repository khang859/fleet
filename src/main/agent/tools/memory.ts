import { stat } from 'node:fs/promises';
import { renderMemory, type MemoryArgsFields } from '../../../shared/agent-memory';
import type { AgentToolContext, AgentToolResult } from '../../../shared/agent-tools';
import { remember } from './freshness';
import { realpathOrNearest } from './paths';

/**
 * Reading one recorded note.
 *
 * Almost `runSkill`, minus the bundled files, plus one thing that is easy to
 * leave out and reads as a bug in the tool when it is: having read an entry
 * counts as having read the file it came from.
 *
 * Without that, the obvious sequence - read a note, notice it is out of date,
 * correct it - costs a refusal and a second read, because `memory_write` applies
 * the same freshness guard `edit` and `write` do and would have no record of
 * this conversation ever having looked. The model would be told to read
 * something it just read.
 *
 * No caching and no "you have this already" check, for the reason `runSkill`
 * gives: a model that asks twice is asking to be reminded, and answering with a
 * note about its own memory is answering a question it did not ask.
 */
export async function runMemoryRead(
  args: MemoryArgsFields,
  ctx: AgentToolContext
): Promise<AgentToolResult> {
  if (ctx.findMemory === null) {
    throw new Error('Nothing has been recorded for this folder yet.');
  }

  const definition = ctx.findMemory(args.name);
  if (definition === null) {
    // The name it asked for rather than a list of the ones there are: the enum
    // in the tool schema already carries the list, and it is sent on every round
    // of this turn.
    throw new Error(`There is no memory called "${args.name}".`);
  }

  // Symlinks resolved, because that is the form the write path records against -
  // it goes through `resolveInsideCwd`, which returns a real path. A stamp
  // stored under the unresolved name would be a stamp nothing ever looks up, and
  // the guard above would be silently useless rather than visibly wrong.
  const abs = realpathOrNearest(definition.path);
  const info = await stat(abs).catch(() => null);
  if (info !== null) remember(ctx.threadId, abs, info);

  const text = renderMemory(definition);
  const lines = text.split('\n').length;
  return { text, summary: `${lines} line${lines === 1 ? '' : 's'}` };
}
