import { describe, it, expect, vi, beforeEach } from 'vitest';

// electron and winston-daily-rotate-file are mocked globally in src/test-setup.ts

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
});
