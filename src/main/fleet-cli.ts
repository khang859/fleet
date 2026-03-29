import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico'
]);

const BINARY_BLOCKLIST = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.iso',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.wasm',
  '.class',
  '.jar',
  '.war',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.flac',
  '.wav',
  '.aac'
]);

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
        if (key === 'depends-on' || key === 'images') {
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
  // Images
  'images.generate': 'image.generate',
  'images.edit': 'image.edit',
  'images.status': 'image.status',
  'images.list': 'image.list',
  'images.retry': 'image.retry',
  'images.config': 'image.config.get',
  'images.action': 'image.action',
  'images.actions': 'image.actions.list'
};

function mapCommand(group: string, action: string): string {
  const cliKey = `${group}.${action}`;
  return COMMAND_MAP[cliKey] ?? cliKey;
}

// ── Client-side validation ────────────────────────────────────────────────────

export function validateCommand(command: string, args: Record<string, unknown>): string | null {
  switch (command) {
    // ── Images ────────────────────────────────────────────────────────────
    case 'image.generate':
      if (!args.prompt)
        return 'Error: images generate requires --prompt.\n\nUsage: fleet images generate --prompt "description"';
      return null;

    case 'image.edit': {
      if (!args.prompt)
        return 'Error: images edit requires --prompt.\n\nUsage: fleet images edit --prompt "description" --images <file1> [file2 ...]';
      if (!args.images)
        return 'Error: images edit requires --images.\n\nUsage: fleet images edit --prompt "description" --images <file1> [file2 ...]';
      const imageFiles = Array.isArray(args.images) ? args.images : [args.images];
      for (const img of imageFiles) {
        if (typeof img !== 'string') continue;
        if (img.startsWith('http://') || img.startsWith('https://')) continue;
        const resolved = resolve(img);
        if (!existsSync(resolved)) {
          return `Error: file not found: ${img}`;
        }
      }
      return null;
    }

    case 'image.status':
    case 'image.retry':
      if (!args.id)
        return `Error: images ${command === 'image.status' ? 'status' : 'retry'} requires an ID.\n\nUsage: fleet images ${command === 'image.status' ? 'status' : 'retry'} <generation-id>`;
      return null;

    case 'image.action': {
      if (!args.action)
        return 'Error: images action requires an action type.\n\nUsage: fleet images action <action-type> <source> [--provider <id>]';
      if (!args.source)
        return 'Error: images action requires a source image.\n\nUsage: fleet images action <action-type> <source> [--provider <id>]';
      return null;
    }

    default:
      return null;
  }
}

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP_TOP = `# Fleet CLI

Manage images and open files from the terminal.

## Usage

  fleet <command> [--key value ...]
  fleet <command> --help

## Commands

| Command | Intent |
|---------|--------|
| images | Generate, edit, and transform AI images. |
| open | Open files or images in Fleet tabs. |

## Examples

\`\`\`bash
fleet images generate --prompt "A cat in space"
fleet open src/main.ts
\`\`\`

Run \`fleet <command> --help\` for detailed help.`;

const HELP_GROUPS: Record<string, string> = {
  open: `# fleet open

Open files or images in Fleet tabs.

## When to use

Use \`fleet open\` when you want to display a file or image in the Fleet app UI.
Supports code files and common image formats (png, jpg, gif, webp, svg).

## Usage

  fleet open <path> [path2 ...]

## Arguments

  <path>    One or more file paths to open. Supports relative and absolute paths.
            Images are opened in image viewer tabs; other files in code tabs.

## Examples

\`\`\`bash
fleet open src/main.ts
fleet open screenshot.png diagram.svg
fleet open ./README.md ../other-repo/notes.txt
\`\`\``,

  images: `
# fleet images

Manage AI image generation.

## Commands

  fleet images generate --prompt "..."         Generate image(s) from a text prompt
  fleet images edit --prompt "..." --images <file1> [file2 ...]  Edit images with a prompt
  fleet images status <id>                     Check generation status
  fleet images list                            List all generations
  fleet images retry <id>                      Retry a failed generation
  fleet images config                          Show current configuration
  fleet images config --api-key <key>          Set fal.ai API key
  fleet images config --action <type> --model <id>  Set model for an action
  fleet images action <type> <source>          Run an action on an image (e.g. remove-background)
  fleet images actions                         List available actions

## Options (generate/edit)

  --provider <id>         Image provider (default: fal-ai)
  --model <model>         Model to use (default: fal-ai/nano-banana-2)
  --resolution <res>      0.5K, 1K, 2K, or 4K (default: 1K)
  --aspect-ratio <ratio>  e.g. 1:1, 16:9, 9:16 (default: 1:1)
  --format <fmt>          png, jpeg, or webp (default: png)
  --num-images <n>        1-4 (default: 1)

## Examples

  fleet images generate --prompt "A cat in space" --resolution 2K
  fleet images edit --prompt "Add a hat" --images ./cat.png
  fleet images config --api-key sk-xxx
  fleet images config --action remove-background --model fal-ai/birefnet/v2
  fleet images action remove-background ./photo.png
  fleet images action remove-background ./photo.png --provider fal-ai
  fleet images actions
`
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
    const files: Array<{ path: string; paneType: 'file' | 'image' }> = [];

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

      const ext = extname(resolved).toLowerCase();
      if (BINARY_BLOCKLIST.has(ext)) {
        errors.push(`Error: unsupported binary file: ${p}`);
        continue;
      }

      const paneType = IMAGE_EXTENSIONS.has(ext) ? ('image' as const) : ('file' as const);
      files.push({ path: resolved, paneType });
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

  // ── Images config (get or set based on flags) ──────────────────────────
  if (group === 'images' && action === 'config') {
    const configArgs = parseArgs(rest.filter((t) => t !== '--quiet'));
    const hasSetFlags = Object.keys(configArgs).some((k) =>
      [
        'api-key',
        'default-model',
        'default-resolution',
        'default-output-format',
        'default-aspect-ratio',
        'provider',
        'action',
        'model'
      ].includes(k)
    );
    const configCommand = hasSetFlags ? 'image.config.set' : 'image.config.get';
    const cli = new FleetCLI(sockPath);
    try {
      const response = opts?.retry
        ? await cli.sendWithRetry(configCommand, configArgs)
        : await cli.send(configCommand, configArgs);
      if (!response.ok) return `Error: ${response.error ?? 'Unknown error'}`;
      if (configCommand === 'image.config.set') return 'Configuration updated.';
      if (isRecord(response.data)) {
        const lines: string[] = [];
        const data = response.data;
        if (data.defaultProvider) lines.push(`defaultProvider: ${toStr(data.defaultProvider)}`);
        const providers = data.providers;
        if (isRecord(providers)) {
          for (const [name, val] of Object.entries(providers)) {
            lines.push(`${name}:`);
            if (isRecord(val)) {
              for (const [k, v] of Object.entries(val)) {
                if (k === 'actions' && isRecord(v)) {
                  lines.push(`  actions:`);
                  for (const [actionName, actionVal] of Object.entries(v)) {
                    lines.push(`    ${actionName}:`);
                    if (isRecord(actionVal)) {
                      for (const [ak, av] of Object.entries(actionVal)) {
                        lines.push(`      ${ak}: ${toStr(av)}`);
                      }
                    }
                  }
                } else {
                  lines.push(`  ${k}: ${toStr(v)}`);
                }
              }
            }
          }
        }
        return lines.join('\n');
      }
      return toStr(response.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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

  // ── image.action: remap positionals to named args ───────────────────────
  if (command === 'image.action') {
    // cleanRest was ['remove-background', './photo.png', ...flags]
    // parseArgs mapped all positionals to 'id' (last wins), so we re-parse:
    const positionals = cleanRest.filter((t) => !t.startsWith('--'));
    if (positionals.length >= 1 && !args.action) args.action = positionals[0];
    if (positionals.length >= 2 && !args.source) {
      const src = positionals[1];
      // Resolve relative file paths to absolute
      if (typeof src === 'string' && !src.startsWith('http') && !src.startsWith('data:')) {
        const resolved = resolve(src);
        if (existsSync(resolved)) {
          args.source = resolved;
        } else {
          // Could be a generation ref like <genId>/image-001.png
          args.source = src;
        }
      } else {
        args.source = src;
      }
    }
  }

  // ── Client-side validation ──────────────────────────────────────────────
  const validationError = validateCommand(command, args);
  if (validationError) return validationError;

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

  // ── image.generate / image.edit formatting ──────────────────────────────
  if (
    (command === 'image.generate' || command === 'image.edit' || command === 'image.action') &&
    isRecord(data) &&
    typeof data.id === 'string'
  ) {
    return `Submitted: ${data.id}`;
  }

  // ── image.status formatting ─────────────────────────────────────────────
  if (command === 'image.status' && isRecord(data)) {
    const lines: string[] = [];
    lines.push(`status: ${toStr(data.status)}`);
    if (data.status === 'completed' || data.status === 'partial') {
      lines.push(`path: ~/.fleet/images/generations/${toStr(data.id)}`);
      if (Array.isArray(data.images)) {
        const filenames = data.images
          .filter(
            (img): img is Record<string, unknown> =>
              isRecord(img) && typeof img.filename === 'string'
          )
          .map((img) => img.filename);
        if (filenames.length > 0) lines.push(`images: ${filenames.join(', ')}`);
      }
    }
    if (data.error) lines.push(`error: ${toStr(data.error)}`);
    return lines.join('\n');
  }

  // ── image.list formatting ───────────────────────────────────────────────
  if (command === 'image.list') {
    if (!Array.isArray(data) || data.length === 0) return 'No images found.';
    const rows = data
      .filter((d): d is Record<string, unknown> => isRecord(d))
      .map((d) => ({
        ID: toStr(d.id),
        STATUS: toStr(d.status),
        MODE: toStr(d.mode),
        MODEL: toStr(d.model),
        PROMPT: toStr(d.prompt).slice(0, 40) + (toStr(d.prompt).length > 40 ? '...' : '')
      }));
    return formatTable(rows);
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
