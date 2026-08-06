import { realpathOrNearest } from './tools/paths';
import { walkFiles } from './tools/walk';
import { GREP_MAX_FILES } from '../../shared/agent-tools';
import type { AgentMentionMatch } from '../../shared/agent-types';

/**
 * Files the composer's `@` menu can offer.
 *
 * Built on the same walk `glob` and `grep` use, so what can be mentioned is
 * exactly what the agent can already see: nothing git was told to forget, and
 * nothing whose name says it holds a secret. A picker that offered a file the
 * sandbox would then refuse would be an invitation to a dead end.
 *
 * Files only. A folder handed over whole is a hundred attachments the user did
 * not choose one by one, and every one of them is context they pay for.
 */

/** Rows the menu shows. More than a screenful is a search that needs narrowing. */
const MENTION_MAX_RESULTS = 20;

export async function searchMentionFiles(query: string, cwd: string): Promise<AgentMentionMatch[]> {
  const needle = query.trim().toLowerCase();
  const root = realpathOrNearest(cwd);

  // Two lists rather than one sort at the end: a match in the file's own name
  // is what the user typed, and a match somewhere up its folders is a
  // coincidence. Ranking them together would bury `read.ts` under every file
  // in a folder called `read`.
  const byName: AgentMentionMatch[] = [];
  const byPath: AgentMentionMatch[] = [];

  await walkFiles(root, GREP_MAX_FILES, (file) => {
    const rel = file.rel.toLowerCase();
    if (needle !== '' && !rel.includes(needle)) return;

    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const match: AgentMentionMatch = { path: file.abs, rel: file.rel };
    if (needle === '' || name.includes(needle)) byName.push(match);
    else byPath.push(match);

    // Enough of both kinds to fill the menu from either. Stopping at
    // MENTION_MAX_RESULTS name matches alone would mean a query that matches no
    // filename anywhere kept walking the whole repository - which is what
    // GREP_MAX_FILES, borrowed from the search that walks the same tree, caps.
    return byName.length < MENTION_MAX_RESULTS || byPath.length < MENTION_MAX_RESULTS;
  });

  return [...byName, ...byPath].slice(0, MENTION_MAX_RESULTS);
}
