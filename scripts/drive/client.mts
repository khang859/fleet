import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run drive` - the thin end of fleet-drive.
 *
 * Runs on bare Node (no tsx, no Playwright) and forwards the command to the
 * daemon (`daemon.ts`), which keeps the CDP connection warm. Starts the daemon
 * when nothing answers. The request and response shapes restate
 * `protocol.ts`, which this file cannot import on bare Node.
 */

type DriveResponse =
  | { id: number; ok: true; output: string; warnings: string[] }
  | { id: number; ok: false; error: string }
  | { id: number; ok: false; restart: true };

const USAGE = `Usage: npm run drive -- <verb> [args]   (or: node scripts/drive/client.mts <verb> [args])

  status                                  attached window and daemon
  screenshot [--selector s] [--out p] [--png]
                                          JPEG by default; --png (or --out *.png) for lossless
  snapshot [--refs]                       ARIA tree; --refs adds [ref=eN] for click/type
  click <sel> [--shot]                    --shot: screenshot after the action
  type <sel> <text> [--shot]
  keys <chord> [--shot]                   renderer shortcuts only, e.g. Meta+K
  eval <js> [--shot]                      runs in the renderer; async is awaited
  fixture [name] [--shot]                 list fixtures, or put the window in one
  cmd [id] [--shot]                       list command-palette commands, or run one
  term [--pane id] [--all]                terminal pane text (active pane; --all for scrollback)
  term-send <text> [--enter] [--pane id]  type into a terminal pane; --enter presses Enter
  term-key <key...> [--pane id]           enter escape tab shift-tab backspace up down left right ctrl-c ctrl-d ctrl-l
  term-wait <regex> [--pane id] [--all]   wait for pane text to match (default --timeout 30000)
  run [file]                              one verb per line, from a file or stdin
  up | stop | restart                     start, stop or restart this checkout's npm run dev

Every verb takes --timeout <ms> (default 5000).
Text may start with a dash (eval '-1+1'). Text that looks like a flag goes after --.`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INFO_PATH = join(ROOT, '.fleet-drive', 'daemon.json');
const DAEMON_START_TIMEOUT_MS = 15_000;

function readSocketPath(): string | undefined {
  try {
    const info: unknown = JSON.parse(readFileSync(INFO_PATH, 'utf8'));
    if (typeof info !== 'object' || info === null || !('socket' in info)) return undefined;
    return typeof info.socket === 'string' ? info.socket : undefined;
  } catch {
    return undefined;
  }
}

async function tryConnect(path: string): Promise<Socket | undefined> {
  return new Promise((done) => {
    const socket = connect(path);
    socket.once('connect', () => done(socket));
    socket.once('error', () => done(undefined));
  });
}

function spawnDaemon(): void {
  mkdirSync(join(ROOT, '.fleet-drive'), { recursive: true });
  const log = openSync(join(ROOT, '.fleet-drive', 'daemon.log'), 'a');
  spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'drive', 'daemon.ts')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log]
  }).unref();
}

async function connectDaemon(fresh: boolean): Promise<Socket> {
  if (!fresh) {
    const path = readSocketPath();
    const socket = path === undefined ? undefined : await tryConnect(path);
    if (socket) return socket;
  }
  spawnDaemon();
  for (let waited = 0; waited < DAEMON_START_TIMEOUT_MS; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
    const path = readSocketPath();
    const socket = path === undefined ? undefined : await tryConnect(path);
    if (socket) return socket;
  }
  throw new Error(
    `The drive daemon did not start. See ${join(ROOT, '.fleet-drive', 'daemon.log')}`
  );
}

function toResponse(value: unknown): DriveResponse {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('ok' in value)) {
    throw new Error('The drive daemon sent a reply this client does not understand.');
  }
  const id = typeof value.id === 'number' ? value.id : 0;
  if (value.ok === true && 'output' in value && typeof value.output === 'string') {
    const warnings =
      'warnings' in value && Array.isArray(value.warnings) ? value.warnings.map(String) : [];
    return { id, ok: true, output: value.output, warnings };
  }
  if ('restart' in value && value.restart === true) return { id, ok: false, restart: true };
  const error = 'error' in value ? String(value.error) : 'unknown error';
  return { id, ok: false, error };
}

/** One request, one response line. Undefined when the daemon hung up without answering. */
async function exchange(socket: Socket, request: object): Promise<DriveResponse | undefined> {
  return new Promise((done, fail) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.destroy();
      try {
        done(toResponse(JSON.parse(buffer.slice(0, end))));
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.once('close', () => done(undefined));
    socket.once('error', fail);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const verb = args.at(0);
  if (verb === undefined || verb === 'help' || verb === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const scriptArg = args
    .slice(1)
    .find((a, i, rest) => !a.startsWith('--') && rest[i - 1] !== '--timeout');
  const readsStdin = verb === 'run' && (scriptArg === undefined || scriptArg === '-');
  if (readsStdin && process.stdin.isTTY) {
    throw new Error('run needs a script file, or the script piped on stdin');
  }
  const request = {
    id: 1,
    verb,
    args: args.slice(1),
    cwd: process.cwd(),
    stdin: readsStdin ? await readStdin() : undefined
  };

  // A daemon whose code changed on disk hands the request back and exits;
  // resend it once to a fresh one.
  let response = await exchange(await connectDaemon(false), request);
  if (response === undefined || 'restart' in response) {
    response = await exchange(await connectDaemon(true), request);
  }
  if (response === undefined) throw new Error('The drive daemon hung up without answering.');
  if (!response.ok) {
    throw new Error(
      'error' in response ? response.error : 'The drive daemon asked for a restart twice.'
    );
  }
  for (const warning of response.warnings) process.stderr.write(`Warning: ${warning}\n`);
  if (response.output !== '') process.stdout.write(`${response.output}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
