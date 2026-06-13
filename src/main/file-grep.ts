import type { ChildProcess } from 'child_process';
import { relative, posix as posixPath } from 'path';
import type { FileGrepRequest, FileGrepResponse, FileGrepResult } from '../shared/ipc-api';
import type { PathContext } from '../shared/shell-profiles';
import { captureBoundedStdout } from './bounded-stdout';
import { spawnInContext } from './run-in-context';

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

function buildRgCommand(
  query: string,
  cwd: string,
  limit: number
): { cmd: string; args: string[] } {
  return {
    cmd: 'rg',
    args: [
      '--no-heading',
      '--line-number',
      '--color',
      'never',
      '--max-count',
      String(limit),
      '-B',
      '1',
      '-A',
      '1',
      '--',
      query,
      cwd
    ]
  };
}

function buildFallbackCommand(
  query: string,
  cwd: string,
  limit: number,
  ctx?: PathContext
): { cmd: string; args: string[] } {
  // A WSL pane always falls back to the distro's grep, never Windows findstr.
  if (!isWslContext(ctx) && process.platform === 'win32') {
    return {
      cmd: 'findstr',
      args: ['/s', '/n', '/i', `/c:${query}`, `${cwd}\\*`]
    };
  }
  return {
    cmd: 'grep',
    args: ['-rn', `-m`, String(limit), `--include=*`, '--', query, cwd]
  };
}

/**
 * Parse ripgrep output (--no-heading --line-number -B 1 -A 1).
 *
 * Match lines:  file:line:text
 * Context lines: file-line-text
 * Block separators: --
 */
function parseRgOutput(
  stdout: string,
  cwd: string,
  limit: number,
  rel: (from: string, to: string) => string
): FileGrepResult[] {
  const results: FileGrepResult[] = [];
  const lines = stdout.split('\n');

  // Group lines into blocks separated by '--'
  // Each block corresponds to one match with its context
  interface Block {
    file: string;
    matchLine: number;
    matchText: string;
    before: string[];
    after: string[];
  }

  const blocks: Block[] = [];
  let currentBlock: Block | null = null;
  let seenMatchInBlock = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line === '--') {
      // Block separator
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = null;
      seenMatchInBlock = false;
      continue;
    }

    // Try match line: file:line:text (colons are separators, file may contain colons on Windows)
    // rg uses ':' for matches and '-' for context lines after the last path separator
    // Format: <file>:<linenum>:<text>  (match)
    //         <file>-<linenum>-<text>  (context)
    // We try match first
    const matchRe = /^(.+):(\d+):(.*)$/;
    const contextRe = /^(.+)-(\d+)-(.*)$/;

    const matchResult = matchRe.exec(line);
    if (matchResult) {
      const [, file, lineNumStr, text] = matchResult;
      const lineNum = parseInt(lineNumStr, 10);

      if (!seenMatchInBlock) {
        // This is a new match — start a new block
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          file,
          matchLine: lineNum,
          matchText: text,
          before: [],
          after: []
        };
        seenMatchInBlock = true;
      }
      // If seenMatchInBlock is true, this could be a subsequent match within the
      // same context window — treat it as a new block
      continue;
    }

    const contextResult = contextRe.exec(line);
    if (contextResult) {
      const [, , lineNumStr, text] = contextResult;
      const lineNum = parseInt(lineNumStr, 10);

      if (currentBlock) {
        if (lineNum < currentBlock.matchLine) {
          currentBlock.before.push(text);
        } else {
          currentBlock.after.push(text);
        }
      }
      continue;
    }
  }

  // Don't forget last block
  if (currentBlock) {
    blocks.push(currentBlock);
  }

  for (const block of blocks) {
    if (results.length >= limit) break;
    results.push({
      file: block.file,
      relativePath: rel(cwd, block.file),
      line: block.matchLine,
      text: block.matchText,
      contextBefore: block.before.length > 0 ? block.before : undefined,
      contextAfter: block.after.length > 0 ? block.after : undefined
    });
  }

  return results;
}

/**
 * Parse fallback grep/findstr output.
 * Format: file:line:text (no context lines)
 */
function parseFallbackOutput(
  stdout: string,
  cwd: string,
  limit: number,
  rel: (from: string, to: string) => string
): FileGrepResult[] {
  const results: FileGrepResult[] = [];
  const lines = stdout.split('\n');

  for (const raw of lines) {
    if (results.length >= limit) break;
    const line = raw.trimEnd();
    if (!line) continue;

    const match = /^(.+):(\d+):(.*)$/.exec(line);
    if (!match) continue;

    const [, file, lineNumStr, text] = match;
    results.push({
      file,
      relativePath: rel(cwd, file),
      line: parseInt(lineNumStr, 10),
      text
    });
  }

  return results;
}

export async function grepFiles(req: FileGrepRequest): Promise<FileGrepResponse> {
  killActive();

  const { requestId, query, cwd, pathContext } = req;
  const limit = req.limit ?? 50;

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  // For a WSL pane the file paths returned by rg/grep are posix; relativize
  // them with posix semantics (win32 `relative` would mangle them).
  const rel = isWslContext(pathContext)
    ? (from: string, to: string): string => posixPath.relative(from, to)
    : (from: string, to: string): string => relative(from, to);
  const { cmd, args } = buildRgCommand(query, cwd, limit);

  return new Promise((resolve) => {
    let timedOut = false;

    const proc = spawnInContext(pathContext ?? 'posix', cmd, args, { cwd });
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, 10000);

    const out = captureBoundedStdout(proc);

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        // rg not found — fall back to grep/findstr
        const { cmd: fbCmd, args: fbArgs } = buildFallbackCommand(query, cwd, limit, pathContext);
        const fbProc = spawnInContext(pathContext ?? 'posix', fbCmd, fbArgs, { cwd });
        activeProcess = fbProc;

        const fbTimer = setTimeout(() => {
          fbProc.kill('SIGTERM');
        }, 10000);

        const fbOut = captureBoundedStdout(fbProc);

        fbProc.on('close', () => {
          clearTimeout(fbTimer);
          activeProcess = null;
          const results = parseFallbackOutput(fbOut.text, cwd, limit, rel);
          resolve({ success: true, requestId, results });
        });

        fbProc.on('error', (fbErr) => {
          clearTimeout(fbTimer);
          activeProcess = null;
          resolve({ success: false, requestId, error: `Grep failed: ${fbErr.message}` });
        });
        return;
      }

      resolve({ success: false, requestId, error: `Grep failed: ${err.message}` });
    });

    proc.on('close', () => {
      clearTimeout(timer);
      activeProcess = null;

      if (timedOut && !out.text.trim()) {
        resolve({ success: false, requestId, error: 'Grep timed out' });
        return;
      }

      const results = parseRgOutput(out.text, cwd, limit, rel);
      resolve({ success: true, requestId, results });
    });
  });
}
