import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CLIResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
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
        result[key] = next;
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
  'missions.update': 'mission.status',
  'missions.show': 'mission.status',
  'missions.status': 'mission.status',
  'missions.cancel': 'mission.cancel',
  'missions.abort': 'mission.cancel',

  // Crew (singular already matches, but add common aliases)
  'crew.info': 'crew.info',
  'crew.status': 'crew.info',
  'crew.show': 'crew.info',
  'crew.dismiss': 'crew.recall',
  'crew.kill': 'crew.recall',
  'crew.stop': 'crew.recall',
  'crew.remove': 'crew.recall',

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
  'cargo.pending': 'cargo.list',
  'cargo.produce': 'cargo.list',

  // Log groups (CLI "log groups list" → "log.show")
  'log.groups': 'log.show',
  'log.list': 'log.show',
}

function mapCommand(group: string, action: string): string {
  const cliKey = `${group}.${action}`
  return COMMAND_MAP[cliKey] ?? cliKey
}

// ── runCLI: parse argv and format output ─────────────────────────────────────

export async function runCLI(argv: string[], sockPath: string): Promise<string> {
  const [group, action, ...rest] = argv;

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

  const cli = new FleetCLI(sockPath);

  let response: CLIResponse;
  try {
    response = await cli.send(command, args);
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

if (typeof process !== 'undefined' && /fleet-cli\.[jt]s$/.test(process.argv[1] ?? '')) {
  const sockPath = join(homedir(), '.fleet', 'fleet.sock');
  runCLI(process.argv.slice(2), sockPath).then((output) => {
    if (output) process.stdout.write(output + '\n');
  });
}
