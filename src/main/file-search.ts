import type { ChildProcess } from 'child_process';
import { stat, realpath } from 'fs/promises';
import { basename, dirname, posix as posixPath } from 'path';
import { homedir } from 'os';
import type { FileSearchRequest, FileSearchResponse, FileSearchResult } from '../shared/ipc-api';
import type { PathContext } from '../shared/shell-profiles';
import { captureBoundedStdout } from './bounded-stdout';
import { spawnInContext } from './run-in-context';
import { toWslUncPath } from '../shared/path-platform';

let activeProcess: ChildProcess | null = null;

// The only object variant of PathContext is the WSL one.
function isWslContext(ctx: PathContext | undefined): ctx is { kind: 'wsl'; distro: string } {
  return typeof ctx === 'object';
}

function killActive(): void {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill('SIGTERM');
  }
  activeProcess = null;
}

function buildCommand(
  query: string,
  scope: string | undefined,
  limit: number,
  ctx: PathContext
): { cmd: string; args: string[] } {
  const escapedQuery = query.replace(/'/g, "\\'");

  // A WSL pane uses the distro's own indexer (locate), like native linux.
  if (isWslContext(ctx)) {
    return {
      cmd: 'locate',
      args: ['-i', '-l', String(limit), '--', `*${query}*`]
    };
  }

  const platform = process.platform;
  const searchScope = scope ?? homedir();

  if (platform === 'darwin') {
    return {
      cmd: 'mdfind',
      args: ['-onlyin', searchScope, `kMDItemDisplayName == '*${escapedQuery}*'cd`]
    };
  }

  if (platform === 'linux') {
    return {
      cmd: 'locate',
      args: ['-i', '-l', String(limit), '--', `*${query}*`]
    };
  }

  return {
    cmd: 'es.exe',
    args: ['-i', '-n', String(limit), '-path', searchScope, query]
  };
}

async function statResult(filePath: string, ctx: PathContext): Promise<FileSearchResult | null> {
  try {
    if (isWslContext(ctx)) {
      // The path is posix; stat it over the UNC bridge but keep posix coords in
      // the result (realpath would rewrite it to a UNC path). Distro temp paths
      // and symlinks are left unresolved — acceptable for a picker.
      const s = await stat(toWslUncPath(ctx.distro, filePath));
      if (!s.isFile()) return null;
      return {
        path: filePath,
        name: posixPath.basename(filePath),
        parentDir: posixPath.dirname(filePath),
        modifiedAt: s.mtimeMs,
        size: s.size
      };
    }
    const resolved = await realpath(filePath);
    const s = await stat(resolved);
    if (!s.isFile()) return null;
    return {
      path: resolved,
      name: basename(resolved),
      parentDir: dirname(resolved),
      modifiedAt: s.mtimeMs,
      size: s.size
    };
  } catch {
    return null;
  }
}

export async function searchFiles(req: FileSearchRequest): Promise<FileSearchResponse> {
  killActive();

  const { requestId, query, scope, pathContext } = req;
  const limit = req.limit ?? 20;
  const ctx: PathContext = pathContext ?? 'posix';
  const wsl = isWslContext(ctx);

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  const { cmd, args } = buildCommand(query, scope, limit, ctx);

  return new Promise((resolve) => {
    const isNonIndexed = cmd === 'powershell' || cmd === 'find';
    const timeout = isNonIndexed ? 5000 : 15000;

    let timedOut = false;

    const proc = spawnInContext(ctx, cmd, args, {});
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    const out = captureBoundedStdout(proc);

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      const errCode = (err as NodeJS.ErrnoException).code;
      const canFallback = cmd === 'locate' || cmd === 'es.exe';
      if (errCode === 'ENOENT' && canFallback) {
        // WSL and native-linux fall back to `find`; native-Windows to PowerShell.
        const useFind = wsl || process.platform !== 'win32';
        const fallbackScope = scope ?? (wsl ? '.' : homedir());
        const fallbackCmd = useFind ? 'find' : 'powershell';
        const fallbackArgs = useFind
          ? [fallbackScope, '-maxdepth', '5', '-iname', `*${query}*`, '-type', 'f']
          : [
              '-NoProfile',
              '-Command',
              `Get-ChildItem -Path '${fallbackScope}' -Recurse -Filter '*${query}*' -File -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`
            ];
        const findProc = spawnInContext(ctx, fallbackCmd, fallbackArgs, {});
        activeProcess = findProc;

        const findTimer = setTimeout(() => {
          findProc.kill('SIGTERM');
        }, 5000);

        const findOut = captureBoundedStdout(findProc);

        findProc.on('close', () => {
          clearTimeout(findTimer);
          activeProcess = null;
          void processResults(findOut.text, limit, requestId, ctx).then(resolve);
        });

        findProc.on('error', () => {
          clearTimeout(findTimer);
          activeProcess = null;
          resolve({ success: false, requestId, error: 'No search tool available' });
        });
        return;
      }

      resolve({ success: false, requestId, error: `Search failed: ${err.message}` });
    });

    proc.on('close', () => {
      clearTimeout(timer);
      activeProcess = null;

      if (timedOut && !out.text.trim()) {
        resolve({ success: false, requestId, error: 'Search timed out' });
        return;
      }

      void processResults(out.text, limit, requestId, ctx).then(resolve);
    });
  });
}

async function processResults(
  stdout: string,
  limit: number,
  requestId: number,
  ctx: PathContext
): Promise<FileSearchResponse> {
  const paths = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, limit * 2);

  const seen = new Set<string>();
  const results: FileSearchResult[] = [];

  for (const p of paths) {
    if (results.length >= limit) break;
    const result = await statResult(p, ctx);
    if (result && !seen.has(result.path)) {
      seen.add(result.path);
      results.push(result);
    }
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { success: true, requestId, results };
}
