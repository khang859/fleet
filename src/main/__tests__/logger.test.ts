import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * src/test-setup.ts mocks electron and winston-daily-rotate-file, but neither
 * mock reaches this module: it reads both through `require`, and vi.mock only
 * intercepts `import`. What keeps the suite out of the real log is
 * FLEET_LOG_DIR, set in vitest.config.ts.
 */

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.LOG_LEVEL;
  });

  it('exports createLogger function', async () => {
    const mod = await import('../logger');
    expect(typeof mod.createLogger).toBe('function');
  });

  it('exports root logger instance', async () => {
    const mod = await import('../logger');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.debug).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.logger.error).toBe('function');
  });

  it('createLogger returns a child logger with tag metadata', async () => {
    const mod = await import('../logger');
    const log = mod.createLogger('test-module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('defaults to debug level when app is not packaged', async () => {
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('debug');
  });

  it('respects LOG_LEVEL env var override', async () => {
    process.env.LOG_LEVEL = 'warn';
    const mod = await import('../logger');
    expect(mod.logger.level).toBe('warn');
  });

  it('writes to FLEET_LOG_DIR when it is set', async () => {
    const configured = process.env.FLEET_LOG_DIR;
    const elsewhere = join(tmpdir(), 'fleet-logger-test');
    process.env.FLEET_LOG_DIR = elsewhere;
    try {
      const mod = await import('../logger');
      expect(mod.LOG_DIR).toBe(elsewhere);
    } finally {
      // Restored rather than deleted: the next import in this file would
      // otherwise fall through to the real home, which is the whole problem.
      process.env.FLEET_LOG_DIR = configured;
    }
  });

  /*
   * The suite runs on the same machine as the app, and the fallback below this
   * is the real home directory. A run that lands there appends test fixtures -
   * failed connections, 502s, ids that were never real - to the log the app is
   * writing, and diagnostics reads that log back as a record of what happened.
   */
  it('never points at the log directory the running app is using', async () => {
    const mod = await import('../logger');
    expect(mod.LOG_DIR).not.toBe(join(homedir(), '.fleet', 'logs'));
  });
});
