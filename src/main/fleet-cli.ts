import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { getPaneTypeForFilePath, isBinaryBlockedFilePath } from '../shared/file-open';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CLIResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isCLIResponse(v: unknown): v is CLIResponse {
  return (
    v != null &&
    typeof v === 'object' &&
    'ok' in v &&
    typeof (v as { ok?: unknown }).ok === 'boolean'
  );
}

export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  waitForAppMs?: number;
  pollIntervalMs?: number;
}

// ── Helper: coerce unknown to string ─────────────────────────────────────────

function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// ── Helper: strip ANSI escape codes ──────────────────────────────────────────

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ── Helper: format array of objects as aligned text table ────────────────────

export function formatTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return '';

  const cols = columns ?? Object.keys(rows[0]);
  if (cols.length === 0) return '';

  // Compute column widths
  const widths: number[] = cols.map((col) => {
    const headerLen = col.length;
    const maxValLen = rows.reduce((max, row) => {
      const val = row[col];
      const valStr = stripAnsi(toStr(val));
      return Math.max(max, valStr.length);
    }, 0);
    return Math.max(headerLen, maxValLen);
  });

  const pad = (str: string, width: number): string => str.padEnd(width);
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = cols.map((col, i) => pad(col, widths[i])).join('  ');

  const dataRows = rows.map((row) =>
    cols
      .map((col, i) => {
        const val = row[col];
        const valStr = stripAnsi(toStr(val));
        return pad(valStr, widths[i]);
      })
      .join('  ')
  );

  return [header, separator, ...dataRows].join('\n');
}

// ── Helper: parse CLI flags ───────────────────────────────────────────────────

export function parseArgs(argv: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];

    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];

      if (next !== undefined && !next.startsWith('--')) {
        if (key === 'depends-on' || key === 'worker') {
          // Accumulate into array for repeated flags
          const existing = result[key];
          result[key] =
            existing === undefined
              ? next
              : Array.isArray(existing)
                ? [...existing.map((x: unknown) => toStr(x)), next]
                : [toStr(existing), next];
        } else {
          result[key] = next;
        }
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      // Positional arg — map to id
      result['id'] = token;
      i += 1;
    }
  }

  return result;
}

// ── FleetCLI class ────────────────────────────────────────────────────────────

export class FleetCLI {
  constructor(private sockPath: string) {}

  async send(
    command: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<CLIResponse> {
    return new Promise((resolve) => {
      const id = randomUUID();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (response: CLIResponse): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(response);
      };

      timer = setTimeout(() => {
        settle({
          id,
          ok: false,
          error: `timeout after ${timeoutMs}ms`,
          code: 'TIMEOUT'
        });
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }, timeoutMs);

      const socket = createConnection(this.sockPath, () => {
        const message = JSON.stringify({ id, command, args }) + '\n';
        socket.write(message);
      });

      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsedRaw: unknown = JSON.parse(line);
            socket.end();
            settle(
              isCLIResponse(parsedRaw) ? parsedRaw : { id, ok: false, error: 'Invalid response' }
            );
          } catch {
            socket.end();
            settle({ id, ok: false, error: 'Invalid JSON response from server' });
          }
        }
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        settle({
          id,
          ok: false,
          error: err.message,
          code: err.code
        });
      });

      socket.on('close', () => {
        // If we closed without getting a response, settle with error
        settle({ id, ok: false, error: 'Connection closed without response' });
      });
    });
  }

  async sendWithRetry(
    command: string,
    args: Record<string, unknown>,
    opts: RetryOptions = {}
  ): Promise<CLIResponse> {
    const {
      maxRetries = 4,
      initialBackoffMs = 200,
      backoffMultiplier = 2,
      waitForAppMs = 15_000,
      pollIntervalMs = 500
    } = opts;

    // Wait for socket file if it doesn't exist
    if (waitForAppMs > 0) {
      if (!existsSync(this.sockPath)) {
        process.stderr.write('Waiting for Fleet app to start...\n');
        const deadline = Date.now() + waitForAppMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollIntervalMs));
          if (existsSync(this.sockPath)) break;
        }
        if (!existsSync(this.sockPath)) {
          return {
            id: '',
            ok: false,
            error: `Fleet app not running (no socket at ${this.sockPath})`,
            code: 'ENOENT'
          };
        }
      }
    }

    // Retry loop for transient connection errors
    let backoff = initialBackoffMs;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.send(command, args);

      // Transient connection error codes worth retrying
      const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ECONNRESET']);

      // Non-transient errors: fail immediately
      if (!result.ok && !TRANSIENT_CODES.has(result.code ?? '')) {
        return result;
      }

      // Success or last attempt: return
      if (result.ok || attempt === maxRetries) {
        return result;
      }

      // Transient error: retry with backoff
      process.stderr.write(
        `Connection failed (${result.code}), retrying (${attempt + 1}/${maxRetries})...\n`
      );
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * backoffMultiplier, 10_000);
    }

    // Should not reach here, but satisfy TypeScript
    return { id: '', ok: false, error: 'Retry exhausted', code: 'RETRY_EXHAUSTED' };
  }
}

// ── Command mapping: CLI names → socket server command names ─────────────────

const COMMAND_MAP: Record<string, string> = {
  'annotate.start': 'annotate.start'
};

function mapCommand(group: string, action: string): string {
  const cliKey = `${group}.${action}`;
  return COMMAND_MAP[cliKey] ?? cliKey;
}

// ── Client-side validation ────────────────────────────────────────────────────

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP_TOP = `# Fleet CLI

Manage files from the terminal.

## Usage

  fleet <command> [--key value ...]
  fleet <command> --help

## Commands

| Command | Intent |
|---------|--------|
| open | Open files or images in Fleet tabs. |
| annotate | Visually annotate web page elements for AI agents. |

## Examples

\`\`\`bash
fleet open src/main.ts
\`\`\`

Run \`fleet <command> --help\` for detailed help.`;

const HELP_GROUPS: Record<string, string> = {
  open: `# fleet open

Open files or images in Fleet tabs.

## When to use

Use \`fleet open\` when you want to display a file or image in the Fleet app UI.
Supports code files, common image formats (png, jpg, gif, webp, svg), and PDFs.

## Usage

  fleet open <path> [path2 ...]

## Arguments

  <path>    One or more file paths to open. Supports relative and absolute paths.
            Images open in image viewer tabs; PDFs in a PDF viewer; other files in code tabs.

## Examples

\`\`\`bash
fleet open src/main.ts
fleet open screenshot.png diagram.svg
fleet open ./README.md ../other-repo/notes.txt
fleet open report.pdf
\`\`\``,

  annotate: `# fleet annotate

Open visual annotation mode to select and annotate web page elements.

## When to use

Use \`fleet annotate\` when you want to visually point out UI elements for an AI agent
to fix. Opens a browser window where you can click elements, add comments, and capture
screenshots. Results are written to a JSON file that agents can read.

## Usage

  fleet annotate [url]
  fleet annotate [url] --timeout <seconds>

## Arguments

  [url]       URL to annotate. If omitted, opens a blank page.
  --timeout   Max seconds to wait for annotation (default: 300).

## Examples

\`\`\`bash
fleet annotate https://localhost:3000
fleet annotate https://example.com --timeout 600
fleet annotate
\`\`\``
};

export function getHelpText(argv: string[]): string | null {
  const hasHelp = argv.includes('--help') || argv.includes('-h');
  if (!hasHelp) return null;

  // Collect positional tokens (non-flag entries)
  const positionals = argv.filter((a) => !a.startsWith('-'));
  const [group] = positionals;

  // No group → top-level help
  if (!group) return HELP_TOP;

  // Group-level help (covers 1-part, 2-part, and 3-part commands)
  if (HELP_GROUPS[group]) {
    return HELP_GROUPS[group];
  }

  // Unknown group → top-level help
  return HELP_TOP;
}

// ── runCLI: parse argv and format output ─────────────────────────────────────

export async function runCLI(
  argv: string[],
  sockPath: string,
  opts?: { retry?: boolean }
): Promise<string> {
  // ── Help intercept (before any command routing) ───────────────────────────
  const helpOutput = getHelpText(argv);
  if (helpOutput !== null) return helpOutput;

  const [group, action, ...rest] = argv;

  // ── Top-level "open" command ─────────────────────────────────────────────
  if (group === 'open') {
    const paths = [action, ...rest].filter(Boolean);
    if (paths.length === 0) {
      return 'Usage: fleet open <path> [path2 ...]';
    }

    const errors: string[] = [];
    const files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' | 'pdf' }> = [];

    for (const p of paths) {
      const resolved = resolve(p);

      if (!existsSync(resolved)) {
        errors.push(`Error: file not found: ${p}`);
        continue;
      }

      if (statSync(resolved).isDirectory()) {
        errors.push(`Error: directories not supported, use a file path: ${p}`);
        continue;
      }

      if (isBinaryBlockedFilePath(resolved)) {
        errors.push(`Error: unsupported binary file: ${p}`);
        continue;
      }

      files.push({ path: resolved, paneType: getPaneTypeForFilePath(resolved) });
    }

    if (files.length === 0) {
      return errors.join('\n');
    }

    const cli = new FleetCLI(sockPath);
    try {
      const response = await cli.send('file.open', { files });
      if (!response.ok) {
        return `Error: ${response.error ?? 'Unknown error'}`;
      }
      const output =
        errors.length > 0
          ? errors.join('\n') + '\n' + `Opened ${files.length} file(s) in Fleet`
          : `Opened ${files.length} file(s) in Fleet`;
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
        return 'Fleet is not running';
      }
      return `Error: ${msg}`;
    }
  }

  // ── Top-level "annotate" command ──────────────────────────────────────────
  if (group === 'annotate') {
    const url = action && !action.startsWith('--') ? action : undefined;
    const allArgs = url ? rest : [action, ...rest].filter(Boolean);
    const parsedArgs = parseArgs(allArgs);
    const timeout = typeof parsedArgs.timeout === 'string' ? Number(parsedArgs.timeout) : undefined;

    const command = 'annotate.start';
    const args: Record<string, unknown> = {};
    if (url) args.url = url;
    if (timeout) args.timeout = timeout;

    const cli = new FleetCLI(sockPath);
    try {
      const response = opts?.retry
        ? await cli.sendWithRetry(command, args)
        : await cli.send(command, args);
      if (!response.ok) {
        return `Error: ${response.error ?? 'Unknown error'}`;
      }
      if (isRecord(response.data) && typeof response.data.resultPath === 'string') {
        return response.data.resultPath;
      }
      return toStr(response.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
        return 'Fleet is not running';
      }
      return `Error: ${msg}`;
    }
  }

  if (!group || !action) {
    return 'Usage: fleet <group> <action> [--key value ...]';
  }

  // Extract --quiet flag
  const quietIdx = rest.indexOf('--quiet');
  const quiet = quietIdx !== -1;
  let cleanRest = quiet ? rest.filter((t) => t !== '--quiet') : rest;

  // Extract --format flag
  const formatIdx = cleanRest.indexOf('--format');
  let format = 'text';
  if (formatIdx !== -1) {
    const formatVal = cleanRest[formatIdx + 1];
    if (formatVal && !formatVal.startsWith('--')) {
      format = formatVal;
      cleanRest = cleanRest.filter((_, i) => i !== formatIdx && i !== formatIdx + 1);
    } else {
      cleanRest = cleanRest.filter((_, i) => i !== formatIdx);
    }
  }

  // Map CLI commands — check for 3-part commands first (e.g. protocols executions list)
  let command: string;
  if (cleanRest.length > 0 && !cleanRest[0].startsWith('--')) {
    const threePartKey = `${group}.${action}.${cleanRest[0]}`;
    if (COMMAND_MAP[threePartKey]) {
      command = COMMAND_MAP[threePartKey];
      cleanRest = cleanRest.slice(1);
    } else {
      command = mapCommand(group, action);
    }
  } else {
    command = mapCommand(group, action);
  }
  const args = parseArgs(cleanRest);

  const cli = new FleetCLI(sockPath);

  let response: CLIResponse;
  try {
    response = opts?.retry ? await cli.sendWithRetry(command, args) : await cli.send(command, args);
  } catch (err) {
    if (quiet) return '';
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }

  // Handle errors
  if (!response.ok) {
    if (quiet) return '';
    return `Error: ${response.error ?? 'Unknown error'}${response.code ? ` (${response.code})` : ''}`;
  }

  const data = response.data;

  // ── JSON format: return raw JSON ──────────────────────────────────────────
  if (format === 'json') {
    return JSON.stringify(data ?? null, null, 2);
  }

  // ── Array → text table ────────────────────────────────────────────────────
  if (Array.isArray(data)) {
    if (data.length === 0) return `No ${group} found.`;
    if (typeof data[0] === 'object' && data[0] !== null) {
      return formatTable(
        data.filter((d): d is Record<string, unknown> => d != null && typeof d === 'object')
      );
    }
    return data.join('\n');
  }

  // ── String → strip ANSI ───────────────────────────────────────────────────
  if (typeof data === 'string') {
    return stripAnsi(data);
  }

  // ── Object → key: value lines ─────────────────────────────────────────────
  if (isRecord(data)) {
    return Object.entries(data)
      .map(([k, v]) => {
        const valStr = typeof v === 'string' ? stripAnsi(v) : toStr(v);
        return `${k}: ${valStr}`;
      })
      .join('\n');
  }

  // ── Default ───────────────────────────────────────────────────────────────
  return toStr(data);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (typeof process !== 'undefined' && /fleet-cli\.(mjs|[jt]s)$/.test(process.argv[1] ?? '')) {
  const suffix = process.env.FLEET_DEV ? '-dev' : '';
  const sockPath = join(homedir(), '.fleet', `fleet${suffix}.sock`);
  void runCLI(process.argv.slice(2), sockPath, { retry: true }).then((output) => {
    if (output) process.stdout.write(output + '\n');
  });
}
