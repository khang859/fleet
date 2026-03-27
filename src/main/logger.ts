import { join } from 'node:path';
import { homedir } from 'node:os';
import winston from 'winston';

/**
 * Resolve Electron app info at module load time. This must NOT use a static
 * `import { app } from 'electron'` because the logger is transitively imported
 * by starbase modules that get bundled into starbase-runtime-process — a plain
 * Node.js child process where `electron` is not available.
 */
function resolveElectronApp(): {
  isPackaged: boolean;
  home: string;
} | null {
  try {
    // electron-vite externalises 'electron' so this resolves in the main
    // process but throws in the runtime child process.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron: unknown = require('electron');
    if (
      electron != null &&
      typeof electron === 'object' &&
      'app' in electron &&
      electron.app != null &&
      typeof electron.app === 'object' &&
      'isPackaged' in electron.app &&
      'getPath' in electron.app &&
      typeof electron.app.getPath === 'function'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed above, require returns any
      const getPath = electron.app.getPath as (name: string) => string;
      return {
        isPackaged: Boolean(electron.app.isPackaged),
        home: String(getPath('home'))
      };
    }
  } catch {
    // Not in Electron (runtime process, tests, CLI tools)
  }
  return null;
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

const logDir = join(electronApp ? electronApp.home : homedir(), '.fleet', 'logs');

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-type-assertion -- dynamic require returns any
  const DailyRotateFile = require('winston-daily-rotate-file') as new (
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
