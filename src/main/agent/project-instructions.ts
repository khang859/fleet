import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateTokens } from '../../shared/agent-context';

/**
 * The project's instructions file, read off disk.
 *
 * `AGENTS.md` first, `CLAUDE.md` second, and nothing else. What the file means
 * and why it is never cut down is in `shared/agent-project-instructions.ts`;
 * this is only the reading.
 *
 * No merge when both exist. `AGENTS.md` wins outright, because merging would
 * mean deciding what to do about two files that contradict each other, and the
 * honest answer is that the project already decided by having both - the newer,
 * shared-format file is the one it wrote for agents in general.
 *
 * No walk up the tree and no file beside the one being edited. The working
 * folder's file or nothing: the pane is opened on a folder, and that folder is
 * the project as far as everything else here is concerned.
 *
 * Read fresh every turn, no cache, consistent with every other definition on
 * disk. A file someone has just edited should be the file the next turn runs on.
 */

/** In order of precedence. The first one that exists and says something wins. */
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];

export type ProjectInstructions = {
  /** The file, byte for byte. Never shortened, however long it is. */
  text: string;
  /** Which of the two was found, for the notice that names it. */
  filename: string;
  /** What it costs, estimated the way the context meter estimates everything. */
  tokens: number;
};

/** The instructions for a pane open on `cwd`, or `null` when there are none. */
export async function loadProjectInstructions(cwd: string): Promise<ProjectInstructions | null> {
  for (const filename of CANDIDATES) {
    let text: string;
    try {
      text = await readFile(join(cwd, filename), 'utf8');
    } catch {
      // Absent is the normal case for at least one of the two, and usually both.
      continue;
    }
    // An empty `AGENTS.md` is a placeholder somebody committed, not a decision
    // to have no instructions - so it falls through to `CLAUDE.md` rather than
    // shadowing it, and an empty pair yields nothing rather than a heading with
    // nothing under it.
    if (text.trim() === '') continue;
    return { text, filename, tokens: estimateTokens(text) };
  }
  return null;
}
