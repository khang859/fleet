import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeniedName } from './paths';
import { ALWAYS_SKIPPED, isIgnored, parseIgnoreRules, type IgnoreScope } from './ignore';

/**
 * Walking a project the way a developer thinks of it: source files, in a stable
 * order, without the directories git was told to forget.
 *
 * Depth-first and alphabetical, so two runs of the same search return the same
 * thing in the same order. Symlinked directories are not followed - a link back
 * up the tree is the one way a walk never finishes, and the file it points at is
 * reachable by its real path anyway.
 */

export type WalkFile = {
  /** Absolute path, for opening. */
  abs: string;
  /** Path relative to the walk root, with forward slashes. What is shown. */
  rel: string;
};

export type WalkResult = {
  /** Files handed to the visitor. */
  visited: number;
  /** True when the walk stopped at `maxFiles` with more left to look at. */
  truncated: boolean;
};

/**
 * Visit every file under `root`, honouring `.gitignore` at each level.
 *
 * The visitor returning `false` stops the walk - a search that has all the
 * matches it can return should not keep reading the rest of the repository.
 */
export async function walkFiles(
  root: string,
  maxFiles: number,
  visit: (file: WalkFile) => boolean | void
): Promise<WalkResult> {
  const result: WalkResult = { visited: 0, truncated: false };

  const descend = async (dir: string, rel: string, inherited: IgnoreScope[]): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is skipped rather than fatal: a permission
      // error deep in a tree should not lose the matches found above it.
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const scopes = entries.some((e) => e.name === '.gitignore')
      ? [...inherited, { dir: rel, rules: await readIgnoreFile(join(dir, '.gitignore')) }]
      : inherited;

    for (const entry of entries) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (isIgnored(scopes, childRel, true)) continue;
        if (!(await descend(childAbs, childRel, scopes))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      if (isDeniedName(entry.name)) continue;
      if (isIgnored(scopes, childRel, false)) continue;

      if (result.visited >= maxFiles) {
        result.truncated = true;
        return false;
      }
      result.visited++;
      if (visit({ abs: childAbs, rel: childRel }) === false) return false;
    }
    return true;
  };

  await descend(root, '', []);
  return result;
}

async function readIgnoreFile(path: string): Promise<ReturnType<typeof parseIgnoreRules>> {
  try {
    return parseIgnoreRules(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}
