import { spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync, statSync } from 'fs';
import type { Page } from 'playwright';
import { driveFilePath, sessionFilePath } from '../../src/shared/drive-session';
import { runningDevInstance, sessionPid } from './instance';

const UP_TIMEOUT_MS = 180_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 200) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

function devLogPath(root: string): string {
  return driveFilePath(root, 'dev.log');
}

/**
 * Stop this checkout's `npm run dev`. Ending the Electron process is enough:
 * electron-vite and npm exit with it.
 *
 * Electron turns SIGTERM into an ordinary quit, so a running terminal puts the
 * "Close Fleet?" dialog in its way. Crashing the renderer answers that dialog
 * with "close anyway" (see `QuitGuard`), and the quit then finishes through
 * `will-quit`, so child processes are still cleaned up.
 */
export async function stopDevApp(getPage: () => Promise<Page>): Promise<string> {
  const instance = await runningDevInstance();
  if (!instance) return 'Fleet dev is not running for this checkout.';
  const { pid } = instance;
  if (pid === undefined || !isAlive(pid)) {
    throw new Error(
      `Something owns CDP port ${instance.port}, but it is not the recorded session.`
    );
  }
  process.kill(pid, 'SIGTERM');
  if (await exitsWithin(pid, 3000)) return `Stopped Fleet dev (pid ${pid}).`;

  const page = await getPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.crash').catch(() => {});
  if (await exitsWithin(pid, 10000)) return `Stopped Fleet dev (pid ${pid}).`;
  throw new Error(`Fleet dev (pid ${pid}) is still running after SIGTERM and a renderer crash.`);
}

/** The session's pid, once a window started after `since` has finished loading. */
function freshSessionPid(root: string, since: number): number | undefined {
  try {
    if (statSync(sessionFilePath(root)).mtimeMs < since) return undefined;
  } catch {
    return undefined;
  }
  const pid = sessionPid(root);
  return pid !== undefined && isAlive(pid) ? pid : undefined;
}

/**
 * The environment to start the app with: this one, minus the markers of the
 * agent session that is running drive. Without this every pane inherits them,
 * and a Claude Code started in a pane to be tested believes it is a child
 * session of the agent (it turns transcript saving off, for one). A dev app
 * started by hand from a terminal has none of these.
 */
function appEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_'))
  );
}

/**
 * Start `npm run dev` detached, so no agent shell owns it and none can lose
 * track of it, and wait until its window has loaded. A no-op when it is up.
 */
export async function startDevApp(root: string): Promise<string> {
  const running = await runningDevInstance();
  if (running) {
    return `Fleet dev is already running (pid ${running.pid ?? 'unknown'}).`;
  }
  const log = devLogPath(root);
  mkdirSync(driveFilePath(root), { recursive: true });
  const fd = openSync(log, 'w');
  const since = Date.now();
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    cwd: root,
    env: appEnv(),
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  // An object, so the check in the loop below is not narrowed to its initial null.
  const exit: { code: number | null } = { code: null };
  child.on('exit', (code) => (exit.code = code ?? 1));
  child.unref();

  for (let waited = 0; waited < UP_TIMEOUT_MS; waited += 250) {
    const pid = freshSessionPid(root, since);
    if (pid !== undefined && (await runningDevInstance())) {
      return `Fleet dev is up (pid ${pid}). Log: ${log}`;
    }
    if (exit.code !== null) {
      const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-15).join('\n');
      throw new Error(
        `npm run dev exited with code ${exit.code} before the window loaded:\n${tail}`
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Fleet dev did not load within ${UP_TIMEOUT_MS / 1000}s. Log: ${log}`);
}

/**
 * Stop, then start, and prove the app that answers is the new one. The old
 * process surviving a restart is how drive once verified stale main code.
 */
export async function restartDevApp(root: string, getPage: () => Promise<Page>): Promise<string> {
  const before = (await runningDevInstance())?.pid;
  const stopped = await stopDevApp(getPage);
  const started = await startDevApp(root);
  const after = (await runningDevInstance())?.pid;
  if (before !== undefined && after === before) {
    throw new Error(`Restart left the same process running (pid ${before}).`);
  }
  return `${stopped}\n${started}`;
}
