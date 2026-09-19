import { createServer, connect, type Server, type Socket } from 'net';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import type { Page } from 'playwright';
import { attach, type Attached } from './core';
import { runVerb } from './dispatch';
import {
  daemonInfoPath,
  daemonSocketPath,
  requestSchema,
  type DaemonInfo,
  type DriveResponse
} from './protocol';

/**
 * Holds one CDP connection to the dev window and serves `npm run drive`
 * requests over a local socket, so a command costs the action and not a fresh
 * Node, tsx, Playwright load and CDP handshake (~600 ms) every time.
 *
 * Started by `client.mts` when nothing answers. One per checkout.
 */

const IDLE_EXIT_MS = 15 * 60_000;

const root = process.cwd();
const socketPath = daemonSocketPath(root);
const infoPath = daemonInfoPath(root);
const startedAt = new Date();

/**
 * This daemon's own code, stamped at start. A daemon that outlives an edit to
 * `scripts/drive/` would keep answering with the old verbs - the same trap as
 * a stale Electron answering for new main-process code - so any change makes
 * it hand the request back and exit.
 */
const SOURCES = [
  ...readdirSync(__dirname)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(__dirname, f)),
  join(root, 'src', 'shared', 'drive-session.ts')
];
const stamp = (): string =>
  SOURCES.map((f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(',');
const startStamp = stamp();

let attached: Attached | null = null;

async function getPage(): Promise<Page> {
  if (attached?.browser.isConnected() && !attached.page.isClosed()) return attached.page;
  attached = await attach();
  const current = attached;
  // The app quit or restarted. Reattach on the next request rather than now:
  // there may be no window to attach to until someone runs `up`.
  current.browser.on('disconnected', () => {
    if (attached === current) attached = null;
  });
  return current.page;
}

function describeDaemon(): string {
  return `Daemon: pid ${process.pid}, up since ${startedAt.toISOString()}`;
}

let idleTimer: NodeJS.Timeout | undefined;
function resetIdleTimer(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void shutdown('idle'), IDLE_EXIT_MS);
}

let server: Server | undefined;
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`${new Date().toISOString()} exiting: ${reason}`);
  server?.close();
  // Free the path now, so a replacement daemon can bind it while this one
  // finishes closing.
  if (process.platform !== 'win32') rmSync(socketPath, { force: true });
  try {
    const info: unknown = JSON.parse(readFileSync(infoPath, 'utf8'));
    if (typeof info === 'object' && info !== null && 'pid' in info && info.pid === process.pid) {
      unlinkSync(infoPath);
    }
  } catch {
    // Already gone, or a newer daemon's; either way not ours to remove.
  }
  // For a CDP connection this only disconnects; the app keeps running.
  await attached?.browser.close().catch(() => {});
  process.exit(0);
}

// One request at a time: two clients clicking at once would interleave their
// actions on the same page.
let queue: Promise<void> = Promise.resolve();

async function handle(line: string): Promise<DriveResponse> {
  let id = 0;
  try {
    const request = requestSchema.parse(JSON.parse(line));
    id = request.id;
    if (stamp() !== startStamp) {
      void shutdown('scripts/drive changed on disk');
      return { id, ok: false, restart: true };
    }
    const result = await runVerb(
      { page: getPage, root, cwd: request.cwd, stdin: request.stdin, describeDaemon },
      [request.verb, ...request.args]
    );
    return { id, ok: true, output: result.output, warnings: result.warnings };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function serve(socket: Socket): void {
  const lines = createInterface({ input: socket });
  lines.on('line', (line) => {
    resetIdleTimer();
    queue = queue.then(async () => {
      const response = await handle(line);
      if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    });
  });
  socket.on('error', () => {});
}

/** Whether another daemon is already answering on the socket. */
async function answering(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function listen(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer(serve);
    s.once('error', reject);
    s.listen(socketPath, () => resolve(s));
  });
}

async function main(): Promise<void> {
  try {
    server = await listen();
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EADDRINUSE')) throw err;
    if (await answering()) {
      console.error('another daemon is already serving this checkout');
      process.exit(0);
    }
    // Left behind by a daemon that died without cleaning up.
    unlinkSync(socketPath);
    server = await listen();
  }
  mkdirSync(dirname(infoPath), { recursive: true });
  const info: DaemonInfo = {
    pid: process.pid,
    socket: socketPath,
    startedAt: startedAt.toISOString()
  };
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
  console.error(`${startedAt.toISOString()} listening on ${socketPath}`);
  resetIdleTimer();
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
