import type { LogEntry } from '../../shared/ipc-api';

export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_SIZE_THRESHOLD = 50;
export const MAX_QUEUE_SIZE = 200;

const isDev = import.meta.env.DEV;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type MetaArg = Record<string, unknown> | (() => Record<string, unknown>);

export interface RendererLogger {
  debug: (message: string, meta?: MetaArg) => void;
  info: (message: string, meta?: MetaArg) => void;
  warn: (message: string, meta?: MetaArg) => void;
  error: (message: string, meta?: MetaArg) => void;
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error'
};

// --- Batch queue (module-level singleton) ---
let queue: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function flush(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    window.fleet.log.batch(batch);
  } catch {
    // IPC not available (tests, early init) — silently drop
  }
}

function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

function enqueue(entry: LogEntry): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Drop oldest entries to prevent unbounded growth
    queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
  }
  queue.push(entry);
  if (queue.length >= FLUSH_SIZE_THRESHOLD) {
    flush();
  }
}

function resolveMeta(meta?: MetaArg): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  if (typeof meta === 'function') return meta();
  // Shallow copy to prevent mutation after logging
  return { ...meta };
}

// --- No-op logger for production ---
const noop = (): void => {};
const noopLogger: RendererLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
};

function createDevLogger(tag: string): RendererLogger {
  ensureFlushTimer();

  function log(level: LogLevel, message: string, meta?: MetaArg): void {
    const resolved = resolveMeta(meta);
    const timestamp = new Date().toISOString();

    // Console output (human-readable)
    const metaStr = resolved && Object.keys(resolved).length > 0
      ? ` ${JSON.stringify(resolved)}`
      : '';
    console[CONSOLE_METHOD[level]](
      `%c${timestamp.slice(11, 23)} [${tag}] ${level}: ${message}${metaStr}`,
      level === 'error' ? 'color: #f87171' :
      level === 'warn' ? 'color: #fbbf24' :
      level === 'debug' ? 'color: #9ca3af' :
      'color: #60a5fa'
    );

    // Enqueue for IPC batch
    enqueue({ tag, level, message, meta: resolved, timestamp });
  }

  return {
    debug: (message, meta?) => log('debug', message, meta),
    info: (message, meta?) => log('info', message, meta),
    warn: (message, meta?) => log('warn', message, meta),
    error: (message, meta?) => log('error', message, meta)
  };
}

export function createLogger(tag: string): RendererLogger {
  return isDev ? createDevLogger(tag) : noopLogger;
}
