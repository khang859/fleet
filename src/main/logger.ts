import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import winston from 'winston';
import { FLEET_HOME, IS_FLEET_DEV } from '../shared/constants';

/**
 * Explicit, because the bare `require` comes from electron-vite's ESM shim. If
 * that shim goes missing, a bare `require` throws, the try/catch blocks below
 * swallow it, and the app runs with no log file and no sign of why. Not named
 * `require` because the shim declares that name at the top of the bundle.
 */
const nodeRequire = createRequire(import.meta.url);

interface ElectronAppInfo {
  isPackaged: boolean;
  home: string;
}

/** Read app info from the `electron` module, or null if it has no usable `app`. */
export function readElectronApp(electron: unknown): ElectronAppInfo | null {
  if (
    electron == null ||
    typeof electron !== 'object' ||
    !('app' in electron) ||
    electron.app == null ||
    typeof electron.app !== 'object' ||
    !('isPackaged' in electron.app) ||
    !('getPath' in electron.app) ||
    typeof electron.app.getPath !== 'function'
  ) {
    return null;
  }

  // Called on `app`: Electron's getPath throws when it is detached from it.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed above, require returns any
  const app = electron.app as { getPath: (name: string) => string };

  return {
    isPackaged: Boolean(electron.app.isPackaged),
    home: String(app.getPath('home'))
  };
}

/**
 * Resolve Electron app info at module load time. This must NOT use a static
 * `import { app } from 'electron'` because the logger is transitively imported
 * by starbase modules that get bundled into starbase-runtime-process — a plain
 * Node.js child process where `electron` is not available.
 */
function resolveElectronApp(): ElectronAppInfo | null {
  try {
    // electron-vite externalises 'electron' so this resolves in the main
    // process but throws in the runtime child process.
    return readElectronApp(nodeRequire('electron'));
  } catch {
    // Not in Electron (runtime process, tests, CLI tools)
    return null;
  }
}

const electronApp = resolveElectronApp();
const isDev = electronApp ? !electronApp.isPackaged : true;
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

const consoleFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf((info) => {
    const rawTag = info.tag;
    const tag = typeof rawTag === 'string' ? rawTag : '';
    const prefix = tag ? `[${tag}]` : '';
    const { timestamp, level: lvl, message, tag: _unusedTag, ...meta } = info;
    void _unusedTag;
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${String(timestamp)} ${prefix} ${String(lvl)}: ${String(message)}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.json()
);

/**
 * Where the daily logs are written.
 *
 * `FLEET_LOG_DIR` wins when it is set. Outside Electron - the runtime child
 * process, CLI tools, and the test suite - `resolveElectronApp` returns null
 * and the fallback is the user's real home, so anything that is not the app
 * itself would otherwise append to the log the app is still writing. A log
 * shared with a test run cannot be read back as evidence of what the app did,
 * and diagnostics reads it back. A dev build logs into its own checkout's
 * folder, apart from the installed app.
 */
const logDir =
  process.env.FLEET_LOG_DIR ??
  (IS_FLEET_DEV
    ? join(FLEET_HOME, 'logs')
    : join(electronApp ? electronApp.home : homedir(), '.fleet', 'logs'));

/** Absolute path to the daily log directory. Single source of truth for any
 * module (e.g. diagnostics) that needs to read these logs back. */
export const LOG_DIR = logDir;

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isDev
      ? winston.format.combine(winston.format.colorize({ all: true }), consoleFormat)
      : consoleFormat
  })
];

// Add file transport when winston-daily-rotate-file is available.
// It may not resolve in the runtime child process if the bundler
// doesn't include it in that entry point.
try {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic require returns any
  const DailyRotateFile = nodeRequire('winston-daily-rotate-file') as new (
    opts: Record<string, unknown>
  ) => winston.transport;
  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'fleet-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: fileFormat
    })
  );
} catch {
  // DailyRotateFile not available — console-only logging
}

export const logger = winston.createLogger({
  level,
  transports
});

export function createLogger(tag: string): winston.Logger {
  return logger.child({ tag });
}
