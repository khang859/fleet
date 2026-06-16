import { readFile } from 'node:fs/promises';
import { posix as posixPath } from 'node:path';
import { toWslUncPath } from '../../shared/path-platform';
import { execInContext, type ExecResult } from '../run-in-context';
import { buildEnvEntry, sortEntries, ENV_EXCLUDE_DIRS, ENV_MAX_DEPTH } from './env-editor-fs';
import type { EnvFileEntry } from '../../shared/env-editor-types';

type Deps = {
  /** Run a command inside the distro. Injected in tests. */
  exec?: (
    ctx: { kind: 'wsl'; distro: string },
    cmd: string,
    args: string[],
    opts?: { cwd?: string; maxBuffer?: number }
  ) => Promise<ExecResult>;
  /** Read a file's UTF-8 text by its Windows-accessible (UNC) path. */
  read?: (absPath: string) => Promise<string>;
};

/**
 * `find` argv that discovers `.env*` files under `rootPosix`, pruning the same
 * directories as the native walker and bounding depth. find counts the root's
 * own files at depth 1, so a file in a dir at our depth-N sits at find depth
 * N+1 — hence `ENV_MAX_DEPTH + 1`.
 */
export function buildFindArgs(rootPosix: string): string[] {
  const args: string[] = [rootPosix, '-maxdepth', String(ENV_MAX_DEPTH + 1), '('];
  ENV_EXCLUDE_DIRS.forEach((name, i) => {
    if (i > 0) args.push('-o');
    args.push('-name', name);
  });
  args.push(')', '-prune', '-o', '-type', 'f', '-name', '.env*', '-print');
  return args;
}

/**
 * ENV_EDITOR_LIST for a WSL pane. A synchronous win32 walk over the
 * `\\wsl.localhost\<distro>` 9P share blocks (and can crash) the main process,
 * so discovery runs *inside* the distro via `find` — mirroring FILE_LIST's
 * `listFilesWsl`. Per-file reads (for the var-count badge) use async fs over the
 * UNC bridge, so a slow/stopped distro yields a slow promise, never a frozen
 * event loop. Returned `absPath`s are UNC so READ/WRITE/RENAME/DELETE work as-is.
 */
export async function listEnvFilesWsl(
  ctx: { kind: 'wsl'; distro: string },
  rootPosix: string,
  deps: Deps = {}
): Promise<EnvFileEntry[]> {
  const exec = deps.exec ?? execInContext;
  const read = deps.read;

  let stdout: string;
  try {
    ({ stdout } = await exec(ctx, 'find', buildFindArgs(rootPosix), {
      cwd: rootPosix,
      maxBuffer: 10 * 1024 * 1024
    }));
  } catch {
    return [];
  }

  const posixPaths = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const entries = await Promise.all(
    posixPaths.map(async (filePosix) => {
      const absPath = toWslUncPath(ctx.distro, filePosix);
      const relPath = posixPath.relative(rootPosix, filePosix);
      let text: string | null;
      try {
        text = read ? await read(absPath) : await readFile(absPath, 'utf8');
      } catch {
        text = null;
      }
      return buildEnvEntry(relPath, absPath, text);
    })
  );

  return sortEntries(entries);
}
