import { spawn, type ChildProcess } from 'child_process';
import { relative } from 'path';
import type { FileGrepRequest, FileGrepResponse, FileGrepResult } from '../shared/ipc-api';

let activeProcess: ChildProcess | null = null;

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
  limit: number
): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
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
function parseRgOutput(stdout: string, cwd: string, limit: number): FileGrepResult[] {
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
      relativePath: relative(cwd, block.file),
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
function parseFallbackOutput(stdout: string, cwd: string, limit: number): FileGrepResult[] {
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
      relativePath: relative(cwd, file),
      line: parseInt(lineNumStr, 10),
      text
    });
  }

  return results;
}

export async function grepFiles(req: FileGrepRequest): Promise<FileGrepResponse> {
  killActive();

  const { requestId, query, cwd } = req;
  const limit = req.limit ?? 50;

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  const { cmd, args } = buildRgCommand(query, cwd, limit);

  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, 10000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        // rg not found — fall back to grep/findstr
        const { cmd: fbCmd, args: fbArgs } = buildFallbackCommand(query, cwd, limit);
        const fbProc = spawn(fbCmd, fbArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        activeProcess = fbProc;
        let fbStdout = '';

        const fbTimer = setTimeout(() => {
          fbProc.kill('SIGTERM');
        }, 10000);

        fbProc.stdout.on('data', (chunk: Buffer) => {
          fbStdout += chunk.toString();
        });

        fbProc.on('close', () => {
          clearTimeout(fbTimer);
          activeProcess = null;
          const results = parseFallbackOutput(fbStdout, cwd, limit);
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

      if (timedOut && !stdout.trim()) {
        resolve({ success: false, requestId, error: 'Grep timed out' });
        return;
      }

      const results = parseRgOutput(stdout, cwd, limit);
      resolve({ success: true, requestId, results });
    });
  });
}
