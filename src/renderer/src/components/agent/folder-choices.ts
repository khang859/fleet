import { fuzzyMatch } from '../../lib/commands';
import { basename, stripTrailing } from '../../lib/path-utils';
import { isScratchDir } from '../../lib/scratch';

/** How many recent folders the switcher lists under the open ones. */
const RECENT_LIMIT = 5;

/**
 * How many folders the switcher lists at most. Enough to show every one
 * without a scrollbar; the filter finds the rest.
 */
const FOLDER_LIMIT = 10;

export type FolderChoice = {
  /** Absolute path the row moves the agent to. */
  path: string;
  /** Folder name, the row's title. */
  name: string;
  /** Open in a tab right now, or only remembered from before. */
  group: 'open' | 'recent';
};

/**
 * The rows of the composer's folder switcher, in the order they are shown.
 *
 * Folders open in a tab come first - they are where the user is working today,
 * which is the answer nearly every time. Recent folders follow, minus any that
 * are already open. The pane's own folder is left out: moving to where you
 * already are is not a choice. Scratch folders are Fleet's, and have a row of
 * their own.
 */
export function folderChoices({
  openFolders,
  recentFolders,
  current,
  filter
}: {
  openFolders: readonly string[];
  recentFolders: readonly string[];
  current: string;
  filter: string;
}): FolderChoice[] {
  const seen = new Set<string>([stripTrailing(current)]);
  const take = (paths: readonly string[], group: FolderChoice['group']): FolderChoice[] => {
    const rows: FolderChoice[] = [];
    for (const path of paths) {
      const key = stripTrailing(path);
      if (seen.has(key) || isScratchDir(path)) continue;
      seen.add(key);
      const name = basename(key) || key;
      if (fuzzyMatch(filter, name) || fuzzyMatch(filter, key))
        rows.push({ path: key, name, group });
    }
    return rows;
  };
  const open = take(openFolders, 'open');
  const recent = take(recentFolders, 'recent').slice(0, RECENT_LIMIT);
  return [...open, ...recent].slice(0, FOLDER_LIMIT);
}
