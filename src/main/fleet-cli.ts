import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

const BINARY_BLOCKLIST = new Set([
  '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dmg', '.pkg', '.deb', '.rpm',
  '.iso', '.bin', '.dll', '.so', '.dylib', '.o', '.a', '.wasm', '.class', '.jar', '.war',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.flac', '.wav', '.aac',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CLIResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  waitForAppMs?: number;
  pollIntervalMs?: number;
}

// ── Helper: strip ANSI escape codes ──────────────────────────────────────────

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ── Helper: format array of objects as aligned text table ────────────────────

export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows || rows.length === 0) return '';

  const cols = columns ?? Object.keys(rows[0]);
  if (cols.length === 0) return '';

  // Compute column widths
  const widths: number[] = cols.map((col) => {
    const headerLen = col.length;
    const maxValLen = rows.reduce((max, row) => {
      const val = row[col];
      const valStr = val == null ? '' : stripAnsi(String(val));
      return Math.max(max, valStr.length);
    }, 0);
    return Math.max(headerLen, maxValLen);
  });

  const pad = (str: string, width: number) => str.padEnd(width);
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = cols.map((col, i) => pad(col, widths[i])).join('  ');

  const dataRows = rows.map((row) =>
    cols.map((col, i) => {
      const val = row[col];
      const valStr = val == null ? '' : stripAnsi(String(val));
      return pad(valStr, widths[i]);
    }).join('  '),
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
        if (key === 'depends-on') {
          // Accumulate into array for repeated flags
          const existing = result[key]
          result[key] = existing === undefined
            ? next
            : Array.isArray(existing)
              ? [...existing, next]
              : [existing as string, next]
        } else {
          result[key] = next
        }
        i += 2
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

  async send(command: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<CLIResponse> {
    return new Promise((resolve) => {
      const id = randomUUID();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (response: CLIResponse) => {
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
          code: 'TIMEOUT',
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
            const parsed = JSON.parse(line) as CLIResponse;
            socket.end();
            settle(parsed);
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
          code: err.code,
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
    opts: RetryOptions = {},
  ): Promise<CLIResponse> {
    const {
      maxRetries = 4,
      initialBackoffMs = 200,
      backoffMultiplier = 2,
      waitForAppMs = 15_000,
      pollIntervalMs = 500,
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
            code: 'ENOENT',
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
      process.stderr.write(`Connection failed (${result.code}), retrying (${attempt + 1}/${maxRetries})...\n`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * backoffMultiplier, 10_000);
    }

    // Should not reach here, but satisfy TypeScript
    return { id: '', ok: false, error: 'Retry exhausted', code: 'RETRY_EXHAUSTED' };
  }
}

// ── Command mapping: CLI names → socket server command names ─────────────────

const COMMAND_MAP: Record<string, string> = {
  // Sectors (CLI uses plural)
  'sectors.list': 'sector.list',
  'sectors.add': 'sector.add',
  'sectors.remove': 'sector.remove',
  'sectors.show': 'sector.info',
  'sectors.info': 'sector.info',

  // Missions (CLI uses plural, different action names)
  'missions.list': 'mission.list',
  'missions.add': 'mission.create',
  'missions.create': 'mission.create',
  'missions.update': 'mission.update',
  'missions.show': 'mission.status',
  'missions.status': 'mission.status',
  'missions.cancel': 'mission.cancel',
  'missions.abort': 'mission.cancel',
  'missions.verdict': 'mission.verdict',

  // Crew (singular already matches, but add common aliases)
  'crew.info': 'crew.info',
  'crew.status': 'crew.info',
  'crew.show': 'crew.info',
  'crew.dismiss': 'crew.recall',
  'crew.kill': 'crew.recall',
  'crew.stop': 'crew.recall',
  'crew.remove': 'crew.recall',
  'crew.message': 'crew.message',
  'crew.msg': 'crew.message',
  'crew.send': 'crew.message',

  // Comms (CLI "inbox" maps to comms.list)
  'comms.inbox': 'comms.list',
  'comms.check': 'comms.check',
  'comms.send': 'comms.send',
  'comms.read': 'comms.read',
  'comms.resolve': 'comms.send',
  'comms.delete': 'comms.delete',
  'comms.clear': 'comms.clear',
  'comms.read-all': 'comms.read-all',
  'comms.show': 'comms.info',
  'comms.info': 'comms.info',

  // Cargo
  'cargo.show': 'cargo.inspect',
  'cargo.inspect': 'cargo.inspect',
  'cargo.pending': 'cargo.pending',
  'cargo.produce': 'cargo.produce',

  // Log groups (CLI "log groups list" → "log.show")
  'log.groups': 'log.show',
  'log.list': 'log.show',
}

function mapCommand(group: string, action: string): string {
  const cliKey = `${group}.${action}`
  return COMMAND_MAP[cliKey] ?? cliKey
}

// ── Client-side validation ────────────────────────────────────────────────────

export function validateCommand(command: string, args: Record<string, unknown>): string | null {
  switch (command) {
    // ── Sectors ────────────────────────────────────────────────────────────
    case 'sector.info':
      if (!args.id && !args.sectorId && !args.name)
        return 'Error: sectors show requires a sector ID.\n\nUsage: fleet sectors show <sector-id>';
      return null;

    case 'sector.add':
      if (!args.path && !args.id)
        return 'Error: sectors add requires --path <path>.\n\nUsage: fleet sectors add --path /path/to/repo';
      return null;

    case 'sector.remove':
      if (!args.id && !args.sectorId && !args.name)
        return 'Error: sectors remove requires a sector ID.\n\nUsage: fleet sectors remove <sector-id>';
      return null;

    // ── Missions ──────────────────────────────────────────────────────────
    case 'mission.create': {
      const usage = 'Usage: fleet missions add --sector <id> --type <code|research|review> --summary "short title" --prompt "detailed instructions"';
      if (!args.sector && !args.sectorId)
        return `Error: missions add requires --sector <id>.\n\n${usage}`;
      if (!args.type) {
        return (
          'Error: missions add requires --type <code|research|review>.\n\n' +
          'Mission types:\n' +
          '  code     — produces git commits (code changes, bug fixes, features)\n' +
          '  research — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
          '  review   — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n\n' +
          usage
        );
      }
      if (args.type !== 'code' && args.type !== 'research' && args.type !== 'review') {
        return (
          `Error: invalid mission type "${args.type}". Must be "code", "research", or "review".\n\n` +
          'Mission types:\n' +
          '  code     — produces git commits (code changes, bug fixes, features)\n' +
          '  research — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
          '  review   — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n\n' +
          usage
        );
      }
      if (!args.prompt)
        return `Error: missions add requires --prompt "...".\n\n${usage}`;
      if (!args.summary)
        return `Error: missions add requires --summary "...".\n\n${usage}`;
      if (args['depends-on'] !== undefined) {
        const depIds = Array.isArray(args['depends-on'])
          ? args['depends-on'] as string[]
          : [args['depends-on'] as string]
        for (const depId of depIds) {
          const n = Number(depId)
          if (isNaN(n) || n <= 0) {
            return `Error: --depends-on must be a numeric mission ID, got: "${depId}".\n\nUsage: fleet missions add ... --depends-on <research-mission-id>`
          }
        }
      }
      return null;
    }

    case 'mission.status':
      if (!args.id && !args.missionId)
        return 'Error: missions show requires a mission ID.\n\nUsage: fleet missions show <mission-id>';
      return null;

    case 'mission.update':
      if (!args.id && !args.missionId)
        return 'Error: missions update requires a mission ID.\n\nUsage: fleet missions update <mission-id> --status <status>';
      return null;

    case 'mission.cancel':
      if (!args.id && !args.missionId)
        return 'Error: missions cancel requires a mission ID.\n\nUsage: fleet missions cancel <mission-id>';
      return null;

    case 'mission.verdict':
      if (!args.id && !args.missionId)
        return 'Error: missions verdict requires a mission ID.\n\nUsage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated> --notes "..."';
      if (!args.verdict)
        return 'Error: missions verdict requires --verdict flag.\n\nUsage: fleet missions verdict <mission-id> --verdict <approved|changes-requested|escalated>';
      return null;

    // ── Crew ──────────────────────────────────────────────────────────────
    case 'crew.deploy': {
      const rawMission = args.mission ?? args.missionId;
      if (rawMission == null) {
        return (
          'Error: crew deploy requires --mission <id>\n\n' +
          'Workflow:\n' +
          '  1. Create a mission:  fleet missions add --sector <id> --summary "..." --prompt "..."\n' +
          '  2. Deploy crew:       fleet crew deploy --sector <id> --mission <mission-id>'
        );
      }
      const missionId = Number(rawMission);
      if (Number.isNaN(missionId) || missionId <= 0) {
        return (
          `Error: --mission must be a numeric mission ID, got: "${rawMission}"\n\n` +
          'It looks like you passed a prompt string to --mission. Create a mission first:\n\n' +
          '  1. Create a mission:  fleet missions add --sector <id> --summary "..." --prompt "..."\n' +
          '  2. Deploy crew:       fleet crew deploy --sector <id> --mission <mission-id>'
        );
      }
      return null;
    }

    case 'crew.recall':
      if (!args.id && !args.crewId)
        return 'Error: crew recall requires a crew ID.\n\nUsage: fleet crew recall <crew-id>\nList crew: fleet crew list';
      return null;

    case 'crew.info':
      if (!args.id && !args.crewId)
        return 'Error: crew info requires a crew ID.\n\nUsage: fleet crew info <crew-id>\nList crew: fleet crew list';
      return null;

    case 'crew.observe':
      if (!args.id && !args.crewId)
        return 'Error: crew observe requires a crew ID.\n\nUsage: fleet crew observe <crew-id>\nList crew: fleet crew list';
      return null;

    case 'crew.message':
      if (!args.id && !args.crewId)
        return 'Error: crew message requires a crew ID.\n\nUsage: fleet crew message <crew-id> --message "..."\nList crew: fleet crew list';
      if (!args.message && !args.text)
        return 'Error: crew message requires --message "...".\n\nUsage: fleet crew message <crew-id> --message "your message here"';
      return null;

    // ── Comms ─────────────────────────────────────────────────────────────
    case 'comms.read':
      if (!args.id && !args.transmissionId)
        return 'Error: comms read requires a transmission ID.\n\nUsage: fleet comms read <transmission-id>\nList transmissions: fleet comms inbox';
      return null;

    case 'comms.send':
      if (!args.to)
        return 'Error: comms send requires --to <crew-id|admiral>.\n\nUsage: fleet comms send --to <crew-id> --message "..."';
      if (!args.message && !args.payload)
        return 'Error: comms send requires --message "...".\n\nUsage: fleet comms send --to <crew-id> --message "your message"';
      return null;

    case 'comms.delete':
      if (!args.id && !args.transmissionId)
        return 'Error: comms delete requires a transmission ID.\n\nUsage: fleet comms delete --id <transmission-id>\nList transmissions: fleet comms inbox';
      return null;

    case 'comms.info':
      if (!args.id && !args.transmissionId)
        return 'Error: comms show requires a transmission ID.\n\nUsage: fleet comms show <transmission-id>\nList transmissions: fleet comms inbox';
      return null;

    // ── Cargo ─────────────────────────────────────────────────────────────
    case 'cargo.inspect':
      if (!args.cargoId && !args.id)
        return 'Error: cargo show requires a cargo ID.\n\nUsage: fleet cargo show <cargo-id>\nList cargo: fleet cargo list';
      return null;

    case 'cargo.pending':
      if (!args.sector && !args.sectorId)
        return 'Error: cargo pending requires --sector <sector-id>.\n\nUsage: fleet cargo pending --sector <sector-id>';
      return null;

    case 'cargo.produce':
      if (!args.sector && !args.sectorId)
        return 'Error: cargo produce requires --sector <sector-id>.\n\nUsage: fleet cargo produce --sector <sector-id> --type <type> --path <path>';
      if (!args.type)
        return 'Error: cargo produce requires --type <type>.\n\nUsage: fleet cargo produce --sector <sector-id> --type <type> --path <path>';
      if (!args.path)
        return 'Error: cargo produce requires --path <path>.\n\nUsage: fleet cargo produce --sector <sector-id> --type <type> --path <path>';
      return null;

    // ── Config ────────────────────────────────────────────────────────────
    case 'config.get':
      if (!args.key)
        return 'Error: config get requires --key <key>.\n\nUsage: fleet config get --key <config-key>';
      return null;

    case 'config.set':
      if (!args.key)
        return 'Error: config set requires --key <key> and --value <value>.\n\nUsage: fleet config set --key <config-key> --value <value>';
      if (args.value === undefined)
        return 'Error: config set requires --value <value>.\n\nUsage: fleet config set --key <config-key> --value <value>';
      return null;

    default:
      return null;
  }
}

// ── runCLI: parse argv and format output ─────────────────────────────────────

export async function runCLI(argv: string[], sockPath: string, opts?: { retry?: boolean }): Promise<string> {
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

      const paneType = IMAGE_EXTENSIONS.has(ext) ? 'image' as const : 'file' as const;
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
      const output = errors.length > 0
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

  // Map CLI commands (plural groups, user-friendly actions) to server commands
  const command = mapCommand(group, action);
  const args = parseArgs(cleanRest);

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

  // ── comms.check special formatting ───────────────────────────────────────
  if (command === 'comms.check') {
    const unread = (data as { unread: number })?.unread ?? 0;
    if (unread === 0) return '';
    return `${unread} unread transmission(s) — run: fleet comms list --unread`;
  }

  // ── Array → text table ────────────────────────────────────────────────────
  if (Array.isArray(data)) {
    if (data.length === 0) return `No ${group} found.`;
    if (typeof data[0] === 'object' && data[0] !== null) {
      return formatTable(data as Record<string, unknown>[]);
    }
    return data.join('\n');
  }

  // ── String → strip ANSI ───────────────────────────────────────────────────
  if (typeof data === 'string') {
    return stripAnsi(data);
  }

  // ── Object → key: value lines ─────────────────────────────────────────────
  if (data !== null && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => {
        const valStr = typeof v === 'string' ? stripAnsi(v) : String(v ?? '');
        return `${k}: ${valStr}`;
      })
      .join('\n');
  }

  // ── Default ───────────────────────────────────────────────────────────────
  return String(data ?? 'OK');
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (typeof process !== 'undefined' && /fleet-cli\.(mjs|[jt]s)$/.test(process.argv[1] ?? '')) {
  const sockPath = join(homedir(), '.fleet', 'fleet.sock');
  runCLI(process.argv.slice(2), sockPath, { retry: true }).then((output) => {
    if (output) process.stdout.write(output + '\n');
  });
}
