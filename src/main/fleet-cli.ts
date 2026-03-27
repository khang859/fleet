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
  'cargo.send': 'cargo.send',

  // Log groups (CLI "log groups list" → "log.show")
  'log.groups': 'log.show',
  'log.list': 'log.show',

  // Protocols
  'protocols.list': 'protocol.list',
  'protocol.list': 'protocol.list',
  'protocols.show': 'protocol.show',
  'protocol.show': 'protocol.show',
  'protocols.enable': 'protocol.enable',
  'protocol.enable': 'protocol.enable',
  'protocols.disable': 'protocol.disable',
  'protocol.disable': 'protocol.disable',
  'protocols.executions.list': 'execution.list',
  'protocols.executions.show': 'execution.show',
  'protocols.executions.update': 'execution.update',
  'protocol.executions.list': 'execution.list',
  'protocol.executions.show': 'execution.show',
  'protocol.executions.update': 'execution.update',

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
      const usage =
        'Usage: fleet missions add --sector <id> --type <code|research|review|architect|repair> --summary "short title" --prompt "detailed instructions"';
      if (!args.sector && !args.sectorId)
        return `Error: missions add requires --sector <id>.\n\n${usage}`;
      if (!args.type) {
        return (
          'Error: missions add requires --type <code|research|review|architect|repair>.\n\n' +
          'Mission types:\n' +
          '  code      — produces git commits (code changes, bug fixes, features)\n' +
          '  research  — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
          '  review    — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n' +
          '  architect — analyzes the codebase and produces an implementation blueprint (no git changes)\n' +
          '  repair    — fixes CI failures or review comments on an existing PR branch (requires --pr-branch)\n\n' +
          usage
        );
      }
      if (
        args.type !== 'code' &&
        args.type !== 'research' &&
        args.type !== 'review' &&
        args.type !== 'architect' &&
        args.type !== 'repair'
      ) {
        return (
          `Error: invalid mission type "${toStr(args.type)}". Must be "code", "research", "review", "architect", or "repair".\n\n` +
          'Mission types:\n' +
          '  code      — produces git commits (code changes, bug fixes, features)\n' +
          '  research  — produces documentation artifacts (investigation, analysis, no git changes expected)\n' +
          '  review    — reviews a PR branch and produces a VERDICT (approved, changes-requested, escalated)\n' +
          '  architect — analyzes the codebase and produces an implementation blueprint (no git changes)\n' +
          '  repair    — fixes CI failures or review comments on an existing PR branch (requires --pr-branch)\n\n' +
          usage
        );
      }
      const prBranch = args['pr-branch'] ? toStr(args['pr-branch']) : undefined;
      if (toStr(args.type) === 'repair' && !prBranch) {
        return `Error: --type repair requires --pr-branch <branch-name>.\n\nUsage: fleet missions add --type repair --pr-branch <branch> --original-mission-id <id> --sector <id> --summary "..." --prompt "..."`;
      }
      if (toStr(args.type) === 'repair' && !args['original-mission-id']) {
        process.stderr.write(
          'Warning: --type repair without --original-mission-id means the automated review dispatch will not trigger after repair completes.\n' +
            'Provide --original-mission-id <code-mission-id> to link this repair to its original mission.\n'
        );
      }
      if (!args.prompt) return `Error: missions add requires --prompt "...".\n\n${usage}`;
      if (!args.summary) return `Error: missions add requires --summary "...".\n\n${usage}`;
      if (args['depends-on'] !== undefined) {
        const depIds = Array.isArray(args['depends-on'])
          ? args['depends-on'].map(toStr)
          : [toStr(args['depends-on'])];
        for (const depId of depIds) {
          const n = Number(depId);
          if (isNaN(n) || n <= 0) {
            return `Error: --depends-on must be a numeric mission ID, got: "${depId}".\n\nUsage: fleet missions add ... --depends-on <research-mission-id>`;
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
          `Error: --mission must be a numeric mission ID, got: "${toStr(rawMission)}"\n\n` +
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

    case 'cargo.send':
      if (!args.type)
        return 'Error: cargo send requires --type <type>.\n\nUsage: fleet cargo send --type <type> --file <path>';
      if (!args.file && !args.content)
        return 'Error: cargo send requires --file <path> or --content "<string>".\n\nUsage: fleet cargo send --type <type> --file <path>';
      if (!args.crewId && process.env.FLEET_CREW_ID) args.crewId = process.env.FLEET_CREW_ID;
      if (!args.missionId && process.env.FLEET_MISSION_ID) args.missionId = process.env.FLEET_MISSION_ID;
      if (!args.sectorId && process.env.FLEET_SECTOR_ID) args.sectorId = process.env.FLEET_SECTOR_ID;
      return null;

    // ── Protocols ──────────────────────────────────────────────────────────
    case 'protocol.show':
      if (!args.id && !args.slug)
        return 'Error: protocols show requires a protocol slug.\n\nUsage: fleet protocols show <slug>\nList protocols: fleet protocols list';
      return null;

    case 'protocol.enable':
      if (!args.id && !args.slug)
        return 'Error: protocols enable requires a protocol slug.\n\nUsage: fleet protocols enable <slug>\nList protocols: fleet protocols list';
      return null;

    case 'protocol.disable':
      if (!args.id && !args.slug)
        return 'Error: protocols disable requires a protocol slug.\n\nUsage: fleet protocols disable <slug>\nList protocols: fleet protocols list';
      return null;

    // ── Executions ────────────────────────────────────────────────────────
    case 'execution.show':
      if (!args.id)
        return 'Error: executions show requires an execution ID.\n\nUsage: fleet protocols executions show <execution-id>\nList executions: fleet protocols executions list';
      return null;

    case 'execution.update':
      if (!args.id)
        return 'Error: executions update requires an execution ID.\n\nUsage: fleet protocols executions update <execution-id> --status <status>';
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

Manage AI coding agents (Crew), Missions, Sectors, and Comms from the terminal.

## When to use

Use \`fleet\` to interact with a running Fleet Starbase — create Missions, deploy
Crew to execute them, monitor progress via Comms, and manage Sectors (repos).

## Usage

  fleet <group> <action> [--key value ...]
  fleet <group> --help
  fleet <group> <action> --help

## Command Groups

| Group | Intent |
|-------|--------|
| sectors | Register and manage code repositories. Use when you need to add a repo, list available repos, or look up a Sector ID before creating a Mission. |
| missions | Create and track agent Missions. Use when you want to define work for a Crew to execute — always create a Mission before deploying Crew. |
| crew | Deploy, observe, and recall Crewmates. Use when you want to start an agent, check its progress, send it a follow-up message, or shut it down. |
| comms | Read and send transmissions. Use when you need to check for messages from Crew, send directives, or manage your inbox. |
| cargo | Inspect, send, and produce Cargo artifacts. Use when you need to view outputs, send explicit cargo from a mission, or record new artifacts. |
| log | View Ship's Log entries. Use when you want to see grouped log entries for debugging or auditing. |
| protocols | Manage and execute multi-step Protocols. Use when you want to list available protocols, view their steps, enable/disable them, or check execution status. |
| images | Generate, edit, and transform AI images. Use when you want to create images from text prompts, edit existing images, run actions like background removal, or check generation status. |
| open | Open files or images in Fleet tabs. Use when you want to display a file in the Fleet UI. |

## Core Workflow

\`\`\`bash
# 1. Check what repos are registered
fleet sectors list

# 2. Create a mission (returns the mission ID)
fleet missions add --sector <id> --type code --summary "..." --prompt "..."

# 3. Deploy crew to execute it
fleet crew deploy --sector <id> --mission <mission-id>

# 4. Monitor progress
fleet crew list
fleet comms inbox --unread
\`\`\`

## Research-First Workflow (recommended for non-trivial changes)

\`\`\`bash
# 1. Create a research mission
fleet missions add --sector <id> --type research --summary "Investigate X" --prompt "..."

# 2. Create a code mission that depends on the research
fleet missions add --sector <id> --type code --summary "Implement X" --prompt "..." --depends-on <research-mission-id>

# 3. Deploy research crew first
fleet crew deploy --sector <id> --mission <research-mission-id>

# 4. When research completes, deploy code crew
fleet crew deploy --sector <id> --mission <code-mission-id>
\`\`\`

Run \`fleet <group> --help\` for detailed help on any command group.`;

const HELP_GROUPS: Record<string, string> = {
  sectors: `# fleet sectors

Manage code repositories (Sectors) registered with this Starbase.

## When to use

Use \`fleet sectors\` when you need to register a new repo, list what repos are
available, look up a Sector ID before creating a Mission, or check a Sector's
agent configuration (model, system prompt, allowed tools).

## Commands

  fleet sectors list                     List all registered Sectors
  fleet sectors add --path <path>        Register a new Sector (path must be a git repo)
  fleet sectors remove <id>              Unregister a Sector
  fleet sectors show <id>                Show full Sector details (config, base branch)

## Arguments

  <id>       Sector ID (shown in \`fleet sectors list\`)
  --path     Absolute path to a git repository root

## Examples

\`\`\`bash
fleet sectors list
fleet sectors add --path /Users/me/projects/my-app
fleet sectors show my-app
fleet sectors remove my-app
\`\`\``,

  missions: `# fleet missions

Create and track agent Missions — the unit of work in Fleet.

## When to use

Use \`fleet missions\` when you want to define work for a Crew to execute.
**Always create a Mission first, then deploy Crew for it** — this two-step
workflow ensures mission prompts are persisted and never lost.

## Commands

  fleet missions list                                List all Missions
  fleet missions list --sector <id>                  Filter by Sector
  fleet missions list --status <status>              Filter by status (queued, active, done, cancelled)
  fleet missions add --sector <id> --type <type> --summary "..." --prompt "..."
                                                     Create a new Mission
  fleet missions add ... --depends-on <id>           Attach a research dependency (repeatable)
  fleet missions show <id>                           Show full Mission details
  fleet missions update <id> --status <status>       Update Mission status
  fleet missions cancel <id>                         Cancel a Mission
  fleet missions verdict <id> --verdict <v>          Record a review verdict

## Mission Types

  code      Produces git commits (code changes, bug fixes, features).
            Use when the work should result in code changes.
  research  Produces documentation artifacts (investigation, analysis).
            Use when you need findings before writing code. No git changes expected.
  review    Reviews a PR branch and produces a VERDICT.
            Use when you need a code review on existing work.

## Arguments for \`missions add\`

  --sector <id>         Required. Sector ID to create the Mission in.
  --type <type>         Required. One of: code, research, review.
  --summary "..."       Required. Short title for the Mission.
  --prompt "..."        Required. Detailed instructions with acceptance criteria.
  --depends-on <id>     Optional. Numeric mission ID of a research dependency.
                        Can be repeated for multiple dependencies.

## Examples

\`\`\`bash
# Create a code mission
fleet missions add --sector my-app --type code --summary "Add POST /api/settings" \\
  --prompt "Add a POST /api/settings endpoint that accepts { theme, notifications }..."

# Create a research mission, then a dependent code mission
fleet missions add --sector my-app --type research --summary "Investigate auth" --prompt "..."
fleet missions add --sector my-app --type code --summary "Implement auth" --prompt "..." --depends-on 1

# List active missions
fleet missions list --status active

# Show a specific mission
fleet missions show 42
\`\`\`

## Good vs Bad Mission Prompts

**Good:** "Add a POST /api/settings endpoint that accepts \`{ theme: string, notifications: boolean }\`, validates input, persists to SQLite, and returns the updated settings. Tests must pass."

**Bad:** "Add a settings feature"`,

  crew: `# fleet crew

Deploy, observe, and recall Crewmates — the AI agents that execute Missions.

## When to use

Use \`fleet crew\` when you want to start an agent session, check what agents are
running, read their output, send follow-up messages, or shut them down.

**Important:** Always create a Mission first with \`fleet missions add\`, then deploy
Crew. Never pass a prompt string to \`--mission\` — it requires a numeric mission ID.

## Commands

  fleet crew list                                    List all deployed Crewmates
  fleet crew list --sector <id>                      Filter by Sector
  fleet crew deploy --sector <id> --mission <id>     Deploy a Crewmate to execute a Mission
  fleet crew info <crew-id>                          Show details for a specific Crewmate
  fleet crew observe <crew-id>                       View recent assistant output from a Crewmate
  fleet crew recall <crew-id>                        Recall (terminate) a Crewmate
  fleet crew message <crew-id> --message "..."       Send a follow-up message to an active Crewmate

## Arguments for \`crew deploy\`

  --sector <id>         Required. Sector ID to deploy into.
  --mission <id>        Required. Numeric mission ID (from \`fleet missions add\`).
  --execution <id>      Optional. Protocol execution ID (for Navigator-driven deploys).

## Two-Step Deploy Workflow

\`\`\`bash
# Step 1: Create the mission (returns the mission ID)
fleet missions add --sector my-app --type code --summary "Add tests" --prompt "..."

# Step 2: Deploy crew to execute it
fleet crew deploy --sector my-app --mission 42
\`\`\`

## Follow-Up Messaging

Send a message to an active Crewmate without recalling them:

\`\`\`bash
fleet crew message <crew-id> --message "Actually, also add integration tests"
\`\`\`

## Examples

\`\`\`bash
fleet crew list
fleet crew list --sector my-app
fleet crew deploy --sector my-app --mission 42
fleet crew info my-app-crew-a1b2
fleet crew observe my-app-crew-a1b2
fleet crew recall my-app-crew-a1b2
fleet crew message my-app-crew-a1b2 --message "Focus on the auth module first"
\`\`\``,

  comms: `# fleet comms

Read and send transmissions — the messaging system between Admiral, Crew, and system.

## When to use

Use \`fleet comms\` when you need to check for unread messages from Crew, send
directives to active agents, respond to questions, or manage your inbox.

## Commands

  fleet comms inbox                                  List all transmissions (read and unread)
  fleet comms inbox --unread                         List only unread transmissions
  fleet comms check                                  Check unread count (silent if zero)
  fleet comms check --quiet                          Exit silently (for scripting)
  fleet comms send --to <crew-id> --message "..."    Send a directive to a Crewmate
  fleet comms send --from <crew-id> --to admiral --message "..."
                                                     Send as a Crewmate to Admiral
  fleet comms resolve <id> --response "..."          Reply to a transmission and mark resolved
  fleet comms read <id>                              Mark a transmission as read
  fleet comms read-all                               Mark all transmissions as read
  fleet comms read-all --crew <crew-id>              Mark all from a specific crew as read
  fleet comms delete --id <id>                       Delete a single transmission
  fleet comms clear                                  Delete all transmissions
  fleet comms clear --crew <crew-id>                 Delete all transmissions for a crew
  fleet comms show <id>                              Show details of a specific transmission

## Arguments for \`comms send\`

  --to <id>             Required. Recipient (crew ID or "admiral").
  --from <id>           Optional. Sender (crew ID). Omit when sending as Admiral.
  --message "..."       Required. Message content.
  --type <type>         Optional. Comms type (e.g. awaiting_feedback, gate-pending).
  --execution <id>      Optional. Protocol execution ID for protocol-related comms.
  --payload '...'       Optional. JSON payload for structured data.

## Examples

\`\`\`bash
fleet comms inbox --unread
fleet comms send --to my-app-crew-a1b2 --message "Use the new API endpoint"
fleet comms resolve 5 --response "Approved, go ahead"
fleet comms read-all
fleet comms clear --crew my-app-crew-a1b2
\`\`\``,

  cargo: `# fleet cargo

Inspect, produce, and send Cargo artifacts — outputs from Missions (research findings, files, etc).

## When to use

Use \`fleet cargo\` when you need to view what artifacts a Mission produced, check
for undelivered cargo, send explicit cargo, or record a new artifact.

## Commands

  fleet cargo list                                   List all Cargo items
  fleet cargo show <id>                              Inspect a specific Cargo item
  fleet cargo pending --sector <id>                  Show undelivered Cargo for a Sector
  fleet cargo send --type <type> --file <path>       Send explicit Cargo from a file
  fleet cargo send --type <type> --content "<str>"   Send explicit Cargo inline
  fleet cargo produce --sector <id> --type <type> --path <path>
                                                     Record a produced Cargo artifact

## Arguments for \`cargo send\`

  --type <type>         Required. Cargo type identifier (e.g. findings, blueprint, review-report).
  --file <path>         Path to the artifact file (relative to working directory or absolute).
  --content "<string>"  Inline content string. Use --file for large content.

Note: --file and --content are mutually exclusive. Provide exactly one.
Crew context (crew ID, mission ID, sector ID) is auto-detected from environment variables.

## Examples

\`\`\`bash
fleet cargo list
fleet cargo show 3
fleet cargo pending --sector my-app
fleet cargo send --type findings --file research-findings.md
fleet cargo send --type blueprint --file architecture.md
fleet cargo send --type review-report --content "APPROVE: All checks pass"
fleet cargo produce --sector my-app --type research-findings --path ./findings.md
\`\`\``,

  log: `# fleet log

View Ship's Log entries — grouped log records for debugging and auditing.

## When to use

Use \`fleet log\` when you want to see grouped log entries, review what happened
during a session, or audit past activity.

## Commands

  fleet log groups list                              List all log groups
  fleet log groups show <id>                         Show entries for a specific log group

## Examples

\`\`\`bash
fleet log groups list
fleet log groups show 1
\`\`\``,

  protocols: `# fleet protocols

Manage and execute multi-step Protocols — automated workflows with gates and steps.

## When to use

Use \`fleet protocols\` when you want to list available protocols, view their steps
and configuration, enable or disable them, or manage protocol executions.

Protocols define structured, multi-step workflows (e.g. feature development with
research → implementation → review gates). Each protocol has ordered steps, and
executions track progress through those steps.

## Commands

  fleet protocols list                               List all available protocols
  fleet protocols show <slug>                        Show protocol details, steps, and help text
  fleet protocols enable <slug>                      Enable a protocol
  fleet protocols disable <slug>                     Disable a protocol

### Protocol Executions (3-part commands)

  fleet protocols executions list                    List all active/recent executions
  fleet protocols executions list --status <status>  Filter by status (running, completed, failed)
  fleet protocols executions show <id>               Show execution detail (current step, status)
  fleet protocols executions update <id> --step <N>           Advance to step N (sequential guard enforced)
  fleet protocols executions update <id> --step <N> --from <M> Skip from step M to step N (for decide steps)
  fleet protocols executions update <id> --status <s>          Update execution status

## Arguments

  <slug>                Protocol slug (shown in \`fleet protocols list\`)
  <id>                  Execution ID (shown in \`fleet protocols executions list\`)
  --status <status>     Filter or update status
  --step <N>            Step number to advance to
  --from <M>            Current step number to skip from (use with --step on decide steps)

## Navigator Workflow

The Navigator executes Protocols step by step:

\`\`\`bash
# 1. Read protocol and execution state
fleet protocols show <slug>
fleet protocols executions show <execution-id>

# 2. Deploy crew for the current step
fleet crew deploy --sector <id> --mission <id> --execution <execution-id>

# 3. Poll for crew completion
fleet comms inbox --execution <execution-id> --unread

# 4. Advance to next step
fleet protocols executions update <execution-id> --step <N+1>
\`\`\`

## Examples

\`\`\`bash
fleet protocols list
fleet protocols show feature-dev
fleet protocols enable feature-dev
fleet protocols executions list
fleet protocols executions list --status running
fleet protocols executions show 7
fleet protocols executions update 7 --step 3
\`\`\``,

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

  config: `# fleet config

Get and set Starbase configuration values.

## When to use

Use \`fleet config\` when you need to read or update Starbase-level settings.

## Commands

  fleet config get <key>                             Get a configuration value
  fleet config set <key> --value <value>             Set a configuration value

## Examples

\`\`\`bash
fleet config get worktree_budget_mb
fleet config set worktree_budget_mb --value 5000
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

  // ── comms.check special formatting ───────────────────────────────────────
  if (command === 'comms.check') {
    const unread =
      data != null &&
      typeof data === 'object' &&
      'unread' in data &&
      typeof data.unread === 'number'
        ? data.unread
        : 0;
    if (unread === 0) return '';
    return `${unread} unread transmission(s) — run: fleet comms list --unread`;
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

  // ── protocol.list formatting ──────────────────────────────────────────────
  if (command === 'protocol.list') {
    if (!Array.isArray(data) || data.length === 0) return 'No protocols registered.';
    return data
      .filter(
        (p): p is { slug: string; name: string; enabled: number; built_in: number } =>
          p != null && typeof p === 'object' && 'slug' in p && 'name' in p
      )
      .map((p) => {
        const status = p.enabled ? '✓' : '✗';
        const tag = p.built_in ? ' [built-in]' : '';
        return `  ${status} ${p.slug.padEnd(30)} ${p.name}${tag}`;
      })
      .join('\n');
  }

  // ── protocol.show formatting ──────────────────────────────────────────────
  if (command === 'protocol.show') {
    if (!data || typeof data !== 'object') return 'Protocol not found.';
    type ProtocolShowData = {
      name: string;
      description?: string;
      help_text?: string;
      trigger_examples?: string;
      steps: Array<{ step_order: number; type: string; description?: string }>;
    };
    function isProtocolShowData(v: unknown): v is ProtocolShowData {
      return (
        v != null &&
        typeof v === 'object' &&
        'name' in v &&
        'steps' in v &&
        Array.isArray((v as { steps?: unknown }).steps)
      );
    }
    if (!isProtocolShowData(data)) return 'Protocol not found.';
    const lines: string[] = [`\n${data.name}\n`];
    if (data.description) lines.push(data.description + '\n');
    if (data.help_text) lines.push(data.help_text + '\n');
    if (data.trigger_examples) {
      try {
        const rawExamples: unknown = JSON.parse(data.trigger_examples);
        const examples = Array.isArray(rawExamples)
          ? rawExamples.filter((e): e is string => typeof e === 'string')
          : [];
        if (examples.length) {
          lines.push('Examples:');
          examples.forEach((e) => lines.push(`  • "${e}"`));
          lines.push('');
        }
      } catch {
        /* ignore malformed JSON */
      }
    }
    lines.push('Steps:');
    for (const s of data.steps) lines.push(`  ${s.step_order}. [${s.type}] ${s.description ?? ''}`);
    return lines.join('\n');
  }

  // ── execution.list formatting ─────────────────────────────────────────────
  if (command === 'execution.list') {
    if (!Array.isArray(data) || data.length === 0) return 'No executions found.';
    return data
      .filter(
        (e): e is { id: string; status: string; current_step: number; feature_request: string } =>
          e != null && typeof e === 'object' && 'id' in e && 'status' in e
      )
      .map(
        (e) =>
          `  ${e.id}  ${e.status.padEnd(15)} step ${e.current_step}  ${e.feature_request.slice(0, 50)}`
      )
      .join('\n');
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
  const sockPath = join(homedir(), '.fleet', 'fleet.sock');
  void runCLI(process.argv.slice(2), sockPath, { retry: true }).then((output) => {
    if (output) process.stdout.write(output + '\n');
  });
}
