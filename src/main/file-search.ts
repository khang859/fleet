import { spawn, type ChildProcess } from 'child_process';
import { stat, realpath } from 'fs/promises';
import { basename, dirname } from 'path';
import { homedir } from 'os';
import type { FileSearchRequest, FileSearchResponse, FileSearchResult } from '../shared/ipc-api';

let activeProcess: ChildProcess | null = null;

function killActive(): void {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill('SIGTERM');
  }
  activeProcess = null;
}

function buildCommand(
  query: string,
  scope: string | undefined,
  limit: number
): { cmd: string; args: string[] } {
  const platform = process.platform;
  const searchScope = scope ?? homedir();
  const escapedQuery = query.replace(/'/g, "\\'");

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

async function statResult(filePath: string): Promise<FileSearchResult | null> {
  try {
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

  const { requestId, query, scope } = req;
  const limit = req.limit ?? 20;

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  const { cmd, args } = buildCommand(query, scope, limit);

  return new Promise((resolve) => {
    const isNonIndexed = cmd === 'powershell' || cmd === 'find';
    const timeout = isNonIndexed ? 5000 : 15000;

    let stdout = '';
    let timedOut = false;

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && (cmd === 'locate' || cmd === 'es.exe')) {
        const fallbackScope = scope ?? homedir();
        const isWin = process.platform === 'win32';
        const fallbackCmd = isWin ? 'powershell' : 'find';
        const fallbackArgs = isWin
          ? ['-NoProfile', '-Command', `Get-ChildItem -Path '${fallbackScope}' -Recurse -Filter '*${query}*' -File -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`]
          : [fallbackScope, '-maxdepth', '5', '-iname', `*${query}*`, '-type', 'f'];
        const findProc = spawn(fallbackCmd, fallbackArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        activeProcess = findProc;
        let findStdout = '';

        const findTimer = setTimeout(() => {
          findProc.kill('SIGTERM');
        }, 5000);

        findProc.stdout.on('data', (chunk: Buffer) => {
          findStdout += chunk.toString();
        });

        findProc.on('close', () => {
          clearTimeout(findTimer);
          activeProcess = null;
          void processResults(findStdout, limit, requestId).then(resolve);
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

      if (timedOut && !stdout.trim()) {
        resolve({ success: false, requestId, error: 'Search timed out' });
        return;
      }

      void processResults(stdout, limit, requestId).then(resolve);
    });
  });
}

async function processResults(
  stdout: string,
  limit: number,
  requestId: number
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
    const result = await statResult(p);
    if (result && !seen.has(result.path)) {
      seen.add(result.path);
      results.push(result);
    }
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { success: true, requestId, results };
}
